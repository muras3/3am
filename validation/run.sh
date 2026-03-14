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
#   DATABASE_URL        Optional. If set, receiver uses PostgresAdapter (default: MemoryAdapter)
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
RECEIVER_ENDPOINT="http://host.docker.internal:${RECEIVER_PORT}"
MAX_DIAGNOSES="${MAX_DIAGNOSES:-1}"
FAST_MODE="${FAST_MODE:-1}"
DATABASE_URL="${DATABASE_URL:-}"
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
  log "ANTHROPIC_API_KEY not set — LLM diagnosis will be skipped"
fi

if ! docker info > /dev/null 2>&1; then
  err "Docker is not running. Start Docker Desktop first."
  exit 1
fi

# ── 2. Start Postgres first (when DATABASE_URL is set) ───────────────────────
if [[ -n "$DATABASE_URL" ]]; then
  log "Starting Postgres (DATABASE_URL mode)..."
  cd "$SCRIPT_DIR"
  RECEIVER_ENDPOINT="$RECEIVER_ENDPOINT" docker compose up -d --wait postgres
  log "Running DB migrations..."
  cd "$REPO_ROOT"
  DATABASE_URL="$DATABASE_URL" pnpm --filter @3amoncall/receiver db:migrate > /dev/null 2>&1
fi

# ── 3. Start Receiver ────────────────────────────────────────────────────────
# Kill any process on the receiver port to ensure correct adapter is used
EXISTING_PID=$(lsof -ti ":$RECEIVER_PORT" 2>/dev/null | head -1 || true)
if [[ -n "$EXISTING_PID" ]]; then
  log "Stopping existing process on port $RECEIVER_PORT (PID $EXISTING_PID)..."
  kill "$EXISTING_PID" 2>/dev/null || true
  sleep 1
fi

log "Starting Receiver on port $RECEIVER_PORT${DATABASE_URL:+ (PostgresAdapter)}..."
cd "$REPO_ROOT"

if [[ -n "$DATABASE_URL" ]]; then
  # Build compiled receiver to avoid tsx watch restart issues
  pnpm --filter @3amoncall/receiver build > /dev/null 2>&1
  DATABASE_URL="$DATABASE_URL" PORT=$RECEIVER_PORT ALLOW_INSECURE_DEV_MODE=true \
    node apps/receiver/dist/server.js > /tmp/3amoncall-receiver.log 2>&1 &
else
  PORT=$RECEIVER_PORT ALLOW_INSECURE_DEV_MODE=true \
    pnpm --filter @3amoncall/receiver dev > /tmp/3amoncall-receiver.log 2>&1 &
fi
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

# ── 4. Docker Compose (validation stack) ─────────────────────────────────────
# Map scenario → Docker Compose profile for scenario-specific services:
#   db_migration_lock_contention           → db-migration (migration-runner)
#   cascading_timeout_downstream_dependency → cascading-timeout (mock-notification-svc)
#   upstream_cdn_stale_cache_poison         → cdn-cache (mock-cdn)
#   secrets_rotation_partial_propagation    → secrets-rotation (mock-sendgrid, web-v2)
COMPOSE_PROFILE=""
case "$SCENARIO" in
  db_migration_lock_contention)            COMPOSE_PROFILE="db-migration" ;;
  cascading_timeout_downstream_dependency) COMPOSE_PROFILE="cascading-timeout" ;;
  upstream_cdn_stale_cache_poison)         COMPOSE_PROFILE="cdn-cache" ;;
  secrets_rotation_partial_propagation)    COMPOSE_PROFILE="secrets-rotation" ;;
esac

log "Starting validation stack (remaining services)${COMPOSE_PROFILE:+ (profile: $COMPOSE_PROFILE)}..."
cd "$SCRIPT_DIR"
if [[ -n "$COMPOSE_PROFILE" ]]; then
  RECEIVER_ENDPOINT="$RECEIVER_ENDPOINT" docker compose --profile "$COMPOSE_PROFILE" up -d --wait
else
  RECEIVER_ENDPOINT="$RECEIVER_ENDPOINT" docker compose up -d --wait otel-collector postgres mock-stripe web loadgen
fi

# ── 4. Run scenario ───────────────────────────────────────────────────────────
log "Running scenario: $SCENARIO (FAST_MODE=$FAST_MODE)"
RECEIVER_ENDPOINT="$RECEIVER_ENDPOINT" docker compose run --rm \
  -e FAST_MODE="$FAST_MODE" \
  scenario-runner node /app/run.js "$SCENARIO"

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
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  log "Running LLM diagnosis (max $MAX_DIAGNOSES call(s))..."
  cd "$REPO_ROOT"
  MAX_DIAGNOSES="$MAX_DIAGNOSES" \
    RECEIVER_BASE_URL="$RECEIVER_BASE_URL" \
    npx tsx "$SCRIPT_DIR/tools/local-diagnose.ts"
else
  log "Skipping LLM diagnosis (ANTHROPIC_API_KEY not set)"
fi

# ── 7. Print result ───────────────────────────────────────────────────────────
log "Fetching result..."
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
