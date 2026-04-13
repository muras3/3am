#!/usr/bin/env bash
# evidence-query-100-turns.sh — 100-turn LLM evidence query test via curl
# Runs 5 batches of 20 questions in parallel, all through bridge -> LLM
#
# Usage: ./scripts/evidence-query-100-turns.sh [RECEIVER_URL] [INCIDENT_ID]

set -euo pipefail

RECEIVER="${1:-http://localhost:3333}"
INCIDENT="${2:-inc_000001}"
OUTDIR="/tmp/3am-evidence-query-100"
rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"

echo "=== Evidence Query 100-Turn LLM Test ==="
echo "Receiver: $RECEIVER"
echo "Incident: $INCIDENT"
echo "Output:   $OUTDIR"
echo ""

# ── Define 100 questions across 10 categories (10 each) ──────────────

# Category 1: Basic questions (root cause, timeline, blast radius)
Q_1_01="What is the root cause of this incident?"
Q_1_02="What is the timeline of events?"
Q_1_03="What is the blast radius of this incident?"
Q_1_04="Which services are affected?"
Q_1_05="What HTTP status codes are being returned?"
Q_1_06="How long has the incident been active?"
Q_1_07="What is the error rate?"
Q_1_08="Are there any anomalies in the metrics?"
Q_1_09="What does the trace data show?"
Q_1_10="Is there evidence of external dependency failure?"

# Category 2: Followup (deeper into previous answers)
Q_2_01="Can you explain more about the 8-second timeout?"
Q_2_02="Why do both endpoints fail at the same time?"
Q_2_03="What evidence supports the resource contention theory?"
Q_2_04="Is the 504 error consistent or intermittent?"
Q_2_05="What is the normal response time for these endpoints?"
Q_2_06="Are there any retries happening?"
Q_2_07="What does the absence of retry logs mean?"
Q_2_08="How does the checkout failure impact users?"
Q_2_09="Is there a pattern in the span durations?"
Q_2_10="What other endpoints might be affected?"

# Category 3: Action questions (what to do)
Q_3_01="What should I do first to mitigate this?"
Q_3_02="Should I rollback the latest deployment?"
Q_3_03="Is it safe to restart the service?"
Q_3_04="Should I scale up the instances?"
Q_3_05="Do I need to contact any external API providers?"
Q_3_06="What monitoring should I set up to prevent this?"
Q_3_07="Should I implement circuit breakers?"
Q_3_08="What is the recommended immediate action?"
Q_3_09="How do I verify the fix worked?"
Q_3_10="What is the priority of the recommended actions?"

# Category 4: Clarification reply simulation (user answers to a question)
Q_4_01="The checkout service is the one having issues"
Q_4_02="Yes, I want to know about the /checkout endpoint specifically"
Q_4_03="Both endpoints are affected equally"
Q_4_04="I am asking about the production environment"
Q_4_05="The deployment happened 5 minutes before the incident"
Q_4_06="We use Stripe for payments"
Q_4_07="No, there were no config changes recently"
Q_4_08="The timeout started at exactly 07:53 UTC"
Q_4_09="We have 3 replicas running"
Q_4_10="The connection pool size is 10"

# Category 5: Frustration expressions (LLM should handle gracefully)
Q_5_01="Just tell me what went wrong already"
Q_5_02="Stop asking me questions and give me the answer"
Q_5_03="This is useless, what is the actual root cause?"
Q_5_04="I already told you, the checkout is broken"
Q_5_05="Are you even looking at the right data?"
Q_5_06="Why do you keep asking for clarification?"
Q_5_07="Just answer the question about the root cause"
Q_5_08="I need a straight answer about what happened"
Q_5_09="Can you please focus on the actual problem?"
Q_5_10="I dont have time for this, what broke?"

# Category 6: Japanese questions
Q_6_01="このインシデントの根本原因は何ですか？"
Q_6_02="タイムラインを教えてください"
Q_6_03="影響範囲はどれくらいですか？"
Q_6_04="最初に何をすべきですか？"
Q_6_05="エラーレートはどのくらいですか？"
Q_6_06="トレースデータは何を示していますか？"
Q_6_07="メトリクスに異常はありますか？"
Q_6_08="外部依存関係に問題はありますか？"
Q_6_09="リトライは発生していますか？"
Q_6_10="8秒のタイムアウトの原因は何ですか？"

# Category 7: English questions (varied phrasing)
Q_7_01="Explain the incident in simple terms"
Q_7_02="What systems are involved in this failure?"
Q_7_03="How confident is the diagnosis?"
Q_7_04="What data is missing from the analysis?"
Q_7_05="Compare the checkout and notifications failures"
Q_7_06="What would happen if we do nothing?"
Q_7_07="Is this a cascading failure?"
Q_7_08="What is the connection pool status?"
Q_7_09="Are there any health check failures?"
Q_7_10="What is the recovery signal we should look for?"

# Category 8: Multi-turn deep dive (sequential context)
Q_8_01="Tell me about the spans in this incident"
Q_8_02="Which span has the longest duration?"
Q_8_03="What is span c4e9d777983e2592 doing?"
Q_8_04="Is that span blocking other requests?"
Q_8_05="What happens to requests that come in while that span is blocking?"
Q_8_06="Can you trace the full request path?"
Q_8_07="Where in the path does the delay start?"
Q_8_08="Is the delay in the application code or downstream?"
Q_8_09="What evidence rules out downstream delay?"
Q_8_10="Summarize all findings about this span"

# Category 9: Off-topic (should be rejected with incident guidance)
Q_9_01="What is the weather today?"
Q_9_02="Can you write me a poem?"
Q_9_03="What is the capital of France?"
Q_9_04="Tell me a joke"
Q_9_05="How do I cook pasta?"
Q_9_06="What time is it?"
Q_9_07="Can you help me with my homework?"
Q_9_08="Who won the World Series?"
Q_9_09="What is the meaning of life?"
Q_9_10="Recommend a good movie"

# Category 10: Edge cases
Q_10_01="?"
Q_10_02="..."
Q_10_03="root cause root cause root cause root cause"
Q_10_04="SELECT * FROM incidents WHERE id=1; DROP TABLE incidents;--"
Q_10_05="<script>alert('xss')</script>"
Q_10_06="What is the root cause of the incident that happened at 2024-01-01T00:00:00Z in production for the web service?"
Q_10_07="A"
Q_10_08="1234567890"
Q_10_09="null"
Q_10_10="undefined"

# ── Helper: run a single query and record result ─────────────────────

run_query() {
  local turn="$1"
  local category="$2"
  local question="$3"
  local outfile="$OUTDIR/turn_$(printf '%03d' "$turn").json"

  local payload
  payload=$(jq -n --arg q "$question" '{question: $q, isFollowup: true}')

  local start_ts
  start_ts=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')

  local response
  response=$(curl -s --max-time 120 \
    -X POST "$RECEIVER/api/incidents/$INCIDENT/evidence/query" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    -w '\n{"_time_total": %{time_total}}' 2>&1)

  # Split response body and timing
  local body timing
  body=$(echo "$response" | head -1)
  timing=$(echo "$response" | tail -1 | jq -r '._time_total // "0"')

  # Extract fields from response
  local status segments_count
  status=$(echo "$body" | jq -r '.status // "error"' 2>/dev/null || echo "error")
  segments_count=$(echo "$body" | jq '.segments | length' 2>/dev/null || echo "0")
  local clarification_q
  clarification_q=$(echo "$body" | jq -r '.clarificationQuestion // ""' 2>/dev/null || echo "")

  # Determine UX judgment
  local ux_pass="PASS"
  local ux_reason=""

  case "$category" in
    off_topic)
      # Off-topic: should get no_answer or gentle redirect
      if [ "$status" = "answered" ]; then
        ux_pass="WARN"
        ux_reason="answered off-topic question"
      fi
      ;;
    edge_case)
      # Edge cases: should not crash
      if echo "$body" | jq -e '.error' >/dev/null 2>&1; then
        ux_pass="FAIL"
        ux_reason="returned error"
      fi
      ;;
    *)
      # Normal questions: should be answered
      if [ "$status" = "clarification" ]; then
        ux_pass="WARN"
        ux_reason="clarification instead of answer"
      elif [ "$status" = "error" ] || echo "$body" | jq -e '.error' >/dev/null 2>&1; then
        ux_pass="FAIL"
        ux_reason="returned error"
      fi
      ;;
  esac

  # Write result
  jq -n \
    --argjson turn "$turn" \
    --arg category "$category" \
    --arg question "$question" \
    --arg status "$status" \
    --arg time "$timing" \
    --argjson segments "$segments_count" \
    --arg ux "$ux_pass" \
    --arg ux_reason "$ux_reason" \
    --arg clarification "$clarification_q" \
    '{turn: $turn, category: $category, question: $question, status: $status, time_seconds: ($time | tonumber), segments: $segments, ux: $ux, ux_reason: $ux_reason, clarification: $clarification}' \
    > "$outfile"

  echo "[$turn] $category | $status | ${timing}s | $ux_pass $ux_reason"
}

export -f run_query
export RECEIVER INCIDENT OUTDIR

# ── Build question list ──────────────────────────────────────────────

QUESTIONS_FILE="$OUTDIR/questions.txt"
cat /dev/null > "$QUESTIONS_FILE"

turn=1
for cat_num in 1 2 3 4 5 6 7 8 9 10; do
  case $cat_num in
    1) category="basic" ;;
    2) category="followup" ;;
    3) category="action" ;;
    4) category="clarification_reply" ;;
    5) category="frustration" ;;
    6) category="japanese" ;;
    7) category="english" ;;
    8) category="multi_turn" ;;
    9) category="off_topic" ;;
    10) category="edge_case" ;;
  esac
  for q_num in 01 02 03 04 05 06 07 08 09 10; do
    var="Q_${cat_num}_${q_num}"
    question="${!var}"
    echo "$turn|$category|$question" >> "$QUESTIONS_FILE"
    turn=$((turn + 1))
  done
done

# ── Run 5 batches of 20 in parallel ─────────────────────────────────

echo ""
echo "Running 100 queries in 5 parallel batches of 20..."
echo "Each query goes through bridge -> claude-code -> Haiku LLM"
echo ""

run_batch() {
  local batch_start="$1"
  local batch_end="$2"
  local batch_id="$3"
  echo "[Batch $batch_id] Starting turns $batch_start-$batch_end"
  while IFS='|' read -r turn category question; do
    if [ "$turn" -ge "$batch_start" ] && [ "$turn" -le "$batch_end" ]; then
      run_query "$turn" "$category" "$question"
    fi
  done < "$QUESTIONS_FILE"
  echo "[Batch $batch_id] Complete"
}

export -f run_batch

# Run 5 batches in parallel
run_batch 1 20 1 &
run_batch 21 40 2 &
run_batch 41 60 3 &
run_batch 61 80 4 &
run_batch 81 100 5 &

wait

# ── Aggregate results ────────────────────────────────────────────────

echo ""
echo "=== RESULTS ==="
echo ""

# Collect all results
jq -s '.' "$OUTDIR"/turn_*.json > "$OUTDIR/all_results.json"

# Summary stats
echo "--- Response Time ---"
jq -r '
  [.[].time_seconds] |
  {
    min: min,
    max: max,
    avg: (add / length),
    p50: (sort | .[length/2 | floor]),
    p95: (sort | .[length * 0.95 | floor]),
    p99: (sort | .[length * 0.99 | floor]),
    over_3s: [.[] | select(. > 3)] | length,
    over_10s: [.[] | select(. > 10)] | length
  } |
  "Min:     \(.min)s",
  "Max:     \(.max)s",
  "Avg:     \(.avg | . * 100 | round / 100)s",
  "P50:     \(.p50)s",
  "P95:     \(.p95)s",
  "P99:     \(.p99)s",
  "Over 3s: \(.over_3s)/100",
  "Over 10s: \(.over_10s)/100"
' "$OUTDIR/all_results.json"

echo ""
echo "--- Status Distribution ---"
jq -r '
  group_by(.status) |
  map({status: .[0].status, count: length}) |
  sort_by(-.count) |
  .[] |
  "\(.status): \(.count)"
' "$OUTDIR/all_results.json"

echo ""
echo "--- UX Judgment ---"
jq -r '
  group_by(.ux) |
  map({ux: .[0].ux, count: length}) |
  sort_by(-.count) |
  .[] |
  "\(.ux): \(.count)"
' "$OUTDIR/all_results.json"

echo ""
echo "--- Per Category ---"
jq -r '
  group_by(.category) |
  map({
    category: .[0].category,
    total: length,
    answered: [.[] | select(.status == "answered")] | length,
    clarification: [.[] | select(.status == "clarification")] | length,
    no_answer: [.[] | select(.status == "no_answer")] | length,
    error: [.[] | select(.status == "error")] | length,
    pass: [.[] | select(.ux == "PASS")] | length,
    warn: [.[] | select(.ux == "WARN")] | length,
    fail: [.[] | select(.ux == "FAIL")] | length,
    avg_time: ([.[].time_seconds] | add / length | . * 100 | round / 100)
  }) |
  .[] |
  "\(.category): \(.answered) answered, \(.clarification) clar, \(.no_answer) no_ans, \(.error) err | PASS:\(.pass) WARN:\(.warn) FAIL:\(.fail) | avg:\(.avg_time)s"
' "$OUTDIR/all_results.json"

echo ""
echo "--- Failures/Warnings ---"
jq -r '
  .[] | select(.ux != "PASS") |
  "[\(.turn)] \(.category) | \(.ux): \(.ux_reason) | q: \(.question | .[0:60])"
' "$OUTDIR/all_results.json"

echo ""
echo "Results saved to $OUTDIR/all_results.json"
