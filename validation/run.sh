#!/usr/bin/env bash
# validation/run.sh — End-to-end local validation pipeline
#
# Starts the Receiver, runs a validation scenario, then runs LLM diagnosis.
#
# Usage:
#   ANTHROPIC_API_KEY=sk-ant-... ./validation/run.sh [scenario_id]
#
# Arguments:
#   scenario_id  - Scenario to run (default: third_party_api_rate_limit_cascade)
#
# Environment variables:
#   ANTHROPIC_API_KEY   Required. Anthropic API key for LLM diagnosis.
#   RECEIVER_PORT       Receiver port (default: 4319)
#   MAX_DIAGNOSES       LLM call limit (default: 1)
#   DIAGNOSIS_MODEL     Model to use (default: claude-sonnet-4-6)
#   FAST_MODE           Set to 1 for fast scenario timing (default: 1)
#
# Prerequisites:
#   - Docker Desktop running
#   - pnpm installed
#   - ANTHROPIC_API_KEY set

set -euo pipefail

SCENARIO="${1:-third_party_api_rate_limit_cascade}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RECEIVER_PORT="${RECEIVER_PORT:-4319}"
RECEIVER_BASE_URL="http://localhost:${RECEIVER_PORT}"
MAX_DIAGNOSES="${MAX_DIAGNOSES:-1}"
FAST_MODE="${FAST_MODE:-1}"
RECEIVER_PID=""

log() { echo "[run.sh] $*"; }
err() { echo "[run.sh] ERROR: $*" >&2; }

cleanup() {
  if [[ -n "$RECEIVER_PID" ]] && kill -0 "$RECEIVER_PID" 2>/dev/null; then
    log "Stopping Receiver (PID $RECEIVER_PID)..."
    kill "$RECEIVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── 1. Prereqs ────────────────────────────────────────────────────────────────
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  err "ANTHROPIC_API_KEY is not set"
  exit 1
fi

if ! docker info > /dev/null 2>&1; then
  err "Docker is not running. Start Docker Desktop first."
  exit 1
fi

# ── 2. Start Receiver (if not already up) ────────────────────────────────────
if curl -sf "$RECEIVER_BASE_URL/api/incidents" > /dev/null 2>&1; then
  log "Receiver already running on port $RECEIVER_PORT"
else
  log "Starting Receiver on port $RECEIVER_PORT..."
  cd "$REPO_ROOT"
  PORT=$RECEIVER_PORT ALLOW_INSECURE_DEV_MODE=true \
    pnpm --filter @3amoncall/receiver dev > /tmp/3amoncall-receiver.log 2>&1 &
  RECEIVER_PID=$!

  for i in $(seq 1 30); do
    curl -sf "$RECEIVER_BASE_URL/api/incidents" > /dev/null 2>&1 && break
    sleep 1
  done

  if ! curl -sf "$RECEIVER_BASE_URL/api/incidents" > /dev/null 2>&1; then
    err "Receiver failed to start. Check /tmp/3amoncall-receiver.log"
    exit 1
  fi
  log "Receiver ready (PID $RECEIVER_PID)"
fi

# ── 3. Docker Compose (validation stack) ─────────────────────────────────────
log "Starting validation stack..."
cd "$SCRIPT_DIR"
docker compose up -d --wait otel-collector postgres mock-stripe web loadgen

# ── 4. Run scenario ───────────────────────────────────────────────────────────
log "Running scenario: $SCENARIO (FAST_MODE=$FAST_MODE)"
docker compose run --rm -e FAST_MODE="$FAST_MODE" scenario-runner \
  node /app/run.js "$SCENARIO"

# ── 5. Wait for traces to reach Receiver ─────────────────────────────────────
log "Waiting for incidents to be ingested..."
sleep 8

INCIDENT_COUNT=$(curl -sf "$RECEIVER_BASE_URL/api/incidents" | \
  python3 -c "import json,sys; print(len(json.load(sys.stdin)['items']))" 2>/dev/null || echo 0)
log "Incidents detected: $INCIDENT_COUNT"

if [[ "$INCIDENT_COUNT" -eq 0 ]]; then
  err "No incidents created. Check OTel Collector → Receiver connectivity."
  exit 1
fi

# ── 6. LLM Diagnosis ─────────────────────────────────────────────────────────
log "Running LLM diagnosis (max $MAX_DIAGNOSES call(s))..."
cd "$REPO_ROOT"
MAX_DIAGNOSES="$MAX_DIAGNOSES" \
  RECEIVER_BASE_URL="$RECEIVER_BASE_URL" \
  npx tsx "$SCRIPT_DIR/tools/local-diagnose.ts"

# ── 7. Print result ───────────────────────────────────────────────────────────
log "Diagnosis complete. Fetching result..."
curl -sf "$RECEIVER_BASE_URL/api/incidents" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for inc in data['items']:
    dr = inc.get('diagnosisResult')
    if not dr:
        continue
    print()
    print('=== INCIDENT:', inc['incidentId'], '===')
    print('What happened:', dr['summary']['what_happened'][:200])
    print('Root cause:   ', dr['summary']['root_cause_hypothesis'][:200])
    print('Action:       ', dr['recommendation']['immediate_action'][:200])
    print('Confidence:   ', dr['confidence']['confidence_assessment'])
"

log "Done! Full result: $RECEIVER_BASE_URL/api/incidents"
