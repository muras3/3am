#!/usr/bin/env bash
# evidence-query-clarification-loop-test.sh — Targeted test for Phase 1+2 clarification fix
# Tests the actual mechanism: history accumulation + replyToClarification enrichment
#
# This is a sequential multi-turn conversation that:
# 1. Sends a question, captures response
# 2. Builds history array from previous turns (Phase 1 test)
# 3. If clarification occurs, sends reply with replyToClarification field (Phase 2 test)
# 4. Verifies the enriched reply gets answered, not another clarification
#
# Usage: ./scripts/evidence-query-clarification-loop-test.sh [RECEIVER_URL] [INCIDENT_ID]

set -euo pipefail

RECEIVER="${1:-http://localhost:3333}"
INCIDENT="${2:-inc_000001}"
OUTDIR="/tmp/3am-clarification-loop-test"
rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"

echo "=== Clarification Loop Targeted Test ==="
echo "Receiver: $RECEIVER"
echo "Incident: $INCIDENT"
echo ""

PASS_COUNT=0
FAIL_COUNT=0
TOTAL=0

# Helper: run a single evidence query with full payload
run_eq() {
  local payload="$1"
  local label="$2"
  local outfile="$OUTDIR/turn_${TOTAL}.json"

  local response
  response=$(curl -s --max-time 120 \
    -X POST "$RECEIVER/api/incidents/$INCIDENT/evidence/query" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    -w '\n{"_time_total": %{time_total}}' 2>&1)

  local body timing
  body=$(echo "$response" | head -1)
  timing=$(echo "$response" | tail -1 | jq -r '._time_total // "0"')

  echo "$body" > "$outfile"

  local status
  status=$(echo "$body" | jq -r '.status // "error"' 2>/dev/null || echo "error")
  local segments
  segments=$(echo "$body" | jq '.segments | length' 2>/dev/null || echo "0")
  local clarification
  clarification=$(echo "$body" | jq -r '.clarificationQuestion // ""' 2>/dev/null || echo "")

  TOTAL=$((TOTAL + 1))
  echo "  [$TOTAL] $label | status=$status | time=${timing}s | segments=$segments"
  if [ -n "$clarification" ]; then
    echo "       clarification: ${clarification:0:80}"
  fi

  # Return values via global vars
  LAST_STATUS="$status"
  LAST_BODY="$body"
  LAST_CLARIFICATION="$clarification"
  LAST_TIME="$timing"
}

assert_status() {
  local expected="$1"
  local context="$2"
  if [ "$LAST_STATUS" = "$expected" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  PASS: $context (got $expected)"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "  FAIL: $context (expected $expected, got $LAST_STATUS)"
  fi
}

assert_not_status() {
  local unexpected="$1"
  local context="$2"
  if [ "$LAST_STATUS" != "$unexpected" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  PASS: $context (not $unexpected, got $LAST_STATUS)"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "  FAIL: $context (got unexpected $unexpected)"
  fi
}

# ── Scenario 1: Multi-turn with history accumulation (Phase 1) ───────

echo ""
echo "--- Scenario 1: Multi-turn history accumulation (Phase 1) ---"
echo "Tests that clarificationQuestion text is included in history for subsequent turns"

HISTORY="[]"

echo ""
echo "Turn 1: Initial question"
run_eq '{"question":"What is the root cause?","isFollowup":false}' "initial question"
assert_status "answered" "initial question should be answered"

# Build history from turn 1
Q1_TEXT=$(echo "$LAST_BODY" | jq -r '.segments | map(.text) | join(" ")' 2>/dev/null)
HISTORY=$(jq -n --arg q "What is the root cause?" --arg a "$Q1_TEXT" \
  '[{"role":"user","content":$q},{"role":"assistant","content":$a}]')

echo ""
echo "Turn 2: Followup with history"
PAYLOAD=$(jq -n --arg q "Can you explain more about the timeout?" --argjson h "$HISTORY" \
  '{question: $q, isFollowup: true, history: $h}')
run_eq "$PAYLOAD" "followup with history"
assert_status "answered" "followup with history should be answered"

# Extend history
Q2_TEXT=$(echo "$LAST_BODY" | jq -r '.segments | map(.text) | join(" ")' 2>/dev/null)
HISTORY=$(echo "$HISTORY" | jq --arg q "Can you explain more about the timeout?" --arg a "$Q2_TEXT" \
  '. + [{"role":"user","content":$q},{"role":"assistant","content":$a}]')

echo ""
echo "Turn 3: Another followup"
PAYLOAD=$(jq -n --arg q "What should I do first?" --argjson h "$HISTORY" \
  '{question: $q, isFollowup: true, history: $h}')
run_eq "$PAYLOAD" "second followup"
assert_status "answered" "second followup should be answered"

# ── Scenario 2: replyToClarification enrichment (Phase 2) ───────────

echo ""
echo "--- Scenario 2: replyToClarification enrichment (Phase 2) ---"
echo "Tests that replyToClarification field enriches question context for LLM"

echo ""
echo "Turn 4: Reply with replyToClarification field"
PAYLOAD=$(jq -n '{
  question: "the checkout service",
  isFollowup: true,
  replyToClarification: {
    originalQuestion: "Which service is having the timeout issues?",
    clarificationText: "Could you specify which service you are asking about? We see multiple services in the trace data:\n1. web (checkout)\n2. web (notifications)"
  },
  history: [
    {"role":"user","content":"Which service is having issues?"},
    {"role":"assistant","content":"Could you specify which service you are asking about? We see multiple services in the trace data:\n1. web (checkout)\n2. web (notifications)"}
  ]
}')
run_eq "$PAYLOAD" "replyToClarification with 'the checkout service'"
assert_status "answered" "clarification reply should be answered, not another clarification"

echo ""
echo "Turn 5: Numbered reply with replyToClarification"
PAYLOAD=$(jq -n '{
  question: "1",
  isFollowup: true,
  replyToClarification: {
    originalQuestion: "What is the error pattern for each endpoint?",
    clarificationText: "Which endpoint would you like me to analyze?\n1. /checkout (POST)\n2. /api/notifications (POST)"
  },
  history: [
    {"role":"user","content":"What is the error pattern?"},
    {"role":"assistant","content":"Which endpoint would you like me to analyze?\n1. /checkout (POST)\n2. /api/notifications (POST)"}
  ]
}')
run_eq "$PAYLOAD" "numbered reply '1' with replyToClarification"
assert_not_status "clarification" "numbered reply should not trigger another clarification"

echo ""
echo "Turn 6: Japanese reply with replyToClarification"
PAYLOAD=$(jq -n '{
  question: "checkoutの方",
  isFollowup: true,
  replyToClarification: {
    originalQuestion: "どのエンドポイントについて詳しく知りたいですか？",
    clarificationText: "どのエンドポイントを分析しますか？\n1. /checkout\n2. /api/notifications"
  },
  history: [
    {"role":"user","content":"エラーの詳細を教えてください"},
    {"role":"assistant","content":"どのエンドポイントを分析しますか？\n1. /checkout\n2. /api/notifications"}
  ]
}')
run_eq "$PAYLOAD" "Japanese reply with replyToClarification"
assert_not_status "clarification" "Japanese clarification reply should not loop"

# ── Scenario 3: Frustration with context (LLM handles naturally) ─────

echo ""
echo "--- Scenario 3: Frustration expressions with context ---"
echo "Tests that LLM handles frustration naturally without deterministic rules"

echo ""
echo "Turn 7: Frustration with history context"
PAYLOAD=$(jq -n '{
  question: "Just tell me the root cause already!",
  isFollowup: true,
  history: [
    {"role":"user","content":"What is the root cause?"},
    {"role":"assistant","content":"The incident shows HTTP 504 timeouts on both /checkout and /api/notifications endpoints."}
  ]
}')
run_eq "$PAYLOAD" "frustration expression with history"
assert_status "answered" "frustration with context should be answered"

echo ""
echo "Turn 8: Short frustration reply"
PAYLOAD=$(jq -n '{
  question: "yes",
  isFollowup: true,
  replyToClarification: {
    originalQuestion: "Do the metrics confirm the error rate spike?",
    clarificationText: "Would you like me to check the metrics for the error rate?"
  },
  history: [
    {"role":"user","content":"Are the metrics abnormal?"},
    {"role":"assistant","content":"Would you like me to check the metrics for the error rate?"}
  ]
}')
run_eq "$PAYLOAD" "'yes' as clarification reply"
assert_not_status "clarification" "'yes' reply to clarification should not loop"

# ── Scenario 4: Without replyToClarification (backward compat) ───────

echo ""
echo "--- Scenario 4: Backward compatibility (no replyToClarification) ---"

echo ""
echo "Turn 9: Normal question without new fields"
run_eq '{"question":"What services are affected?"}' "basic question without new fields"
assert_status "answered" "basic question without new fields should work"

echo ""
echo "Turn 10: Followup without replyToClarification"
PAYLOAD=$(jq -n '{
  question: "Tell me more about the traces",
  isFollowup: true,
  history: [
    {"role":"user","content":"What services are affected?"},
    {"role":"assistant","content":"The web service is affected with HTTP 504 errors on both /checkout and /api/notifications."}
  ]
}')
run_eq "$PAYLOAD" "followup without replyToClarification"
assert_status "answered" "followup without new fields should work"

# ── Summary ──────────────────────────────────────────────────────────

echo ""
echo "=== SUMMARY ==="
echo "Total assertions: $((PASS_COUNT + FAIL_COUNT))"
echo "PASS: $PASS_COUNT"
echo "FAIL: $FAIL_COUNT"
echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "RESULT: FAILED"
  exit 1
else
  echo "RESULT: ALL PASS"
  exit 0
fi
