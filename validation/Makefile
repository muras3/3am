# validation/Makefile
#
# Three test environments:
#   make local    — receiver on host, Docker containers send OTel to localhost
#   make cf       — receiver on CF Workers, Docker containers send OTel to staging
#   make vercel   — receiver on Vercel, Docker containers send OTel to preview/prod
#
# Quick start (local):
#   make local
#   make local DB=1 DIAGNOSE=1
#
# Quick start (cf):
#   make cf                               # up + run + down (all-in-one)
#   make cf-up && make cf-run             # manual control
#   make cf-down
#
# Quick start (vercel):
#   make vercel                           # up + run + down (all-in-one)
#   make vercel-up && make vercel-run     # manual control
#   make vercel-down

SCENARIO        ?= third_party_api_rate_limit_cascade
DB              ?= 0
DIAGNOSE        ?= 0
FAST_MODE       ?= 1
USE_CLAUDE_CLI  ?= 0
DIAGNOSIS_MODEL ?= claude-sonnet-4-6
MAX_DIAGNOSES   ?= 1

COMPOSE_FILES := -f docker-compose.yml -f docker-compose.staging.yml
ENV_FILE      ?= .env.staging
DC            := docker compose $(COMPOSE_FILES) --env-file $(ENV_FILE)

.PHONY: local cf cf-up cf-run cf-down cf-diagnose vercel vercel-up vercel-run vercel-down vercel-diagnose up run down ps logs check-env check-env-vercel help

# ── Local ────────────────────────────────────────────────────────────────────

local:
	@cd .. && \
	  $(if $(filter 1,$(DB)),DATABASE_URL=postgres://validation:validation@localhost:5432/validation) \
	  $(if $(filter 1,$(DIAGNOSE)),ANTHROPIC_API_KEY=$(ANTHROPIC_API_KEY)) \
	  USE_CLAUDE_CLI=$(USE_CLAUDE_CLI) \
	  DIAGNOSIS_MODEL=$(DIAGNOSIS_MODEL) \
	  MAX_DIAGNOSES=$(MAX_DIAGNOSES) \
	  FAST_MODE=$(FAST_MODE) bash validation/run.sh $(SCENARIO)

# ── Cloudflare Workers ───────────────────────────────────────────────────────

cf: cf-up cf-run cf-down

cf-up: check-env
	$(DC) up -d --wait otel-collector postgres mock-stripe web loadgen

cf-run: check-env
	$(DC) run --rm -e FAST_MODE=$(FAST_MODE) scenario-runner node /app/run.js $(SCENARIO)

cf-down:
	@[ -f $(ENV_FILE) ] && $(DC) down || docker compose down

# Run diagnosis against CF Workers receiver using CLI (no API charges)
# Prerequisite: make cf must have completed (incident must exist on CF Workers)
cf-diagnose: check-env
	@export $$(grep -v '^#' $(ENV_FILE) | xargs) && \
	  cd .. && \
	  RECEIVER_BASE_URL=$$RECEIVER_ENDPOINT \
	  RECEIVER_AUTH_TOKEN=$$RECEIVER_AUTH_TOKEN \
	  USE_CLAUDE_CLI=$(USE_CLAUDE_CLI) \
	  DIAGNOSIS_MODEL=$(DIAGNOSIS_MODEL) \
	  MAX_DIAGNOSES=$(MAX_DIAGNOSES) \
	  npx tsx validation/tools/local-diagnose.ts

# Legacy aliases (backward compat)
up: cf-up
run: cf-run
down: cf-down

# ── Vercel ──────────────────────────────────────────────────────────────────

VERCEL_ENV_FILE   ?= .env.vercel
VERCEL_DC         := docker compose $(COMPOSE_FILES) --env-file $(VERCEL_ENV_FILE)

vercel: vercel-up vercel-run vercel-down

vercel-up: check-env-vercel
	$(VERCEL_DC) up -d --wait otel-collector postgres mock-stripe web loadgen

vercel-run: check-env-vercel
	$(VERCEL_DC) run --rm -e FAST_MODE=$(FAST_MODE) scenario-runner node /app/run.js $(SCENARIO)

vercel-down:
	@[ -f $(VERCEL_ENV_FILE) ] && $(VERCEL_DC) down || docker compose down

vercel-diagnose: check-env-vercel
	@export $$(grep -v '^#' $(VERCEL_ENV_FILE) | xargs) && \
	  cd .. && \
	  RECEIVER_BASE_URL=$$RECEIVER_ENDPOINT \
	  RECEIVER_AUTH_TOKEN=$$RECEIVER_AUTH_TOKEN \
	  USE_CLAUDE_CLI=$(USE_CLAUDE_CLI) \
	  DIAGNOSIS_MODEL=$(DIAGNOSIS_MODEL) \
	  MAX_DIAGNOSES=$(MAX_DIAGNOSES) \
	  npx tsx validation/tools/local-diagnose.ts

# ── Utilities ─────────────────────────────────────────────────────────────────

ps:
	$(DC) ps

logs:
	$(DC) logs -f otel-collector

check-env:
	@test -f $(ENV_FILE) || \
	  (echo "ERROR: $(ENV_FILE) not found."; \
	   echo "  cp .env.staging.example .env.staging"; \
	   echo "  Then fill in RECEIVER_ENDPOINT and RECEIVER_AUTH_TOKEN"; \
	   exit 1)
	@grep -q 'RECEIVER_ENDPOINT=https://' $(ENV_FILE) || \
	  (echo "ERROR: RECEIVER_ENDPOINT must be https://...workers.dev or custom domain"; exit 1)
	@grep -qE 'RECEIVER_AUTH_TOKEN=.{10}' $(ENV_FILE) || \
	  (echo "ERROR: RECEIVER_AUTH_TOKEN missing or too short"; exit 1)
	@echo "OK: $(ENV_FILE) looks valid"
	@echo "  endpoint: $$(grep RECEIVER_ENDPOINT $(ENV_FILE) | cut -d= -f2)"

check-env-vercel:
	@test -f $(VERCEL_ENV_FILE) || \
	  (echo "ERROR: $(VERCEL_ENV_FILE) not found."; \
	   echo "  cp .env.vercel.example .env.vercel"; \
	   echo "  Then fill in RECEIVER_ENDPOINT and RECEIVER_AUTH_TOKEN"; \
	   exit 1)
	@grep -q 'RECEIVER_ENDPOINT=https://' $(VERCEL_ENV_FILE) || \
	  (echo "ERROR: RECEIVER_ENDPOINT must be https://...vercel.app"; exit 1)
	@grep -qE 'RECEIVER_AUTH_TOKEN=.{10}' $(VERCEL_ENV_FILE) || \
	  (echo "ERROR: RECEIVER_AUTH_TOKEN missing or too short"; exit 1)
	@echo "OK: $(VERCEL_ENV_FILE) looks valid"
	@echo "  endpoint: $$(grep RECEIVER_ENDPOINT $(VERCEL_ENV_FILE) | cut -d= -f2)"

help:
	@echo ""
	@echo "Local testing (receiver on host):"
	@echo "  make local                          run scenario with MemoryAdapter"
	@echo "  make local DB=1                     + Postgres persistence"
	@echo "  make local DIAGNOSE=1               + LLM diagnosis (API key)"
	@echo "  make local DIAGNOSE=1 USE_CLAUDE_CLI=1              Max plan (no charge)"
	@echo "  make local DIAGNOSE=1 USE_CLAUDE_CLI=1 DIAGNOSIS_MODEL=claude-opus-4-6"
	@echo "  make local DIAGNOSE=1 USE_CLAUDE_CLI=1 DIAGNOSIS_MODEL=gpt-5.4"
	@echo "  make local SCENARIO=<id>            specific scenario"
	@echo ""
	@echo "CF Workers staging:"
	@echo "  make cf                             up + run + down (all-in-one)"
	@echo "  make cf-up                          start local containers → CF Workers"
	@echo "  make cf-run                         run scenario"
	@echo "  make cf-run SCENARIO=<id>           specific scenario"
	@echo "  make cf-down                        tear down"
	@echo "  make cf-diagnose USE_CLAUDE_CLI=1                   diagnose CF incident via CLI"
	@echo "  make cf-diagnose USE_CLAUDE_CLI=1 DIAGNOSIS_MODEL=claude-opus-4-6"
	@echo "  make cf-diagnose USE_CLAUDE_CLI=1 DIAGNOSIS_MODEL=gpt-5.4"
	@echo ""
	@echo "Vercel staging:"
	@echo "  make vercel                         up + run + down (all-in-one)"
	@echo "  make vercel-up                      start local containers → Vercel"
	@echo "  make vercel-run                     run scenario"
	@echo "  make vercel-run SCENARIO=<id>       specific scenario"
	@echo "  make vercel-down                    tear down"
	@echo "  make vercel-diagnose USE_CLAUDE_CLI=1              diagnose Vercel incident via CLI"
	@echo ""
	@echo "Utilities:"
	@echo "  make check-env                      verify .env.staging"
	@echo "  make check-env-vercel               verify .env.vercel"
	@echo "  make ps                             container status"
	@echo "  make logs                           tail otel-collector logs"
	@echo ""
	@echo "Scenarios:"
	@echo "  third_party_api_rate_limit_cascade       (default)"
	@echo "  cascading_timeout_downstream_dependency"
	@echo "  db_migration_lock_contention"
	@echo "  secrets_rotation_partial_propagation"
	@echo "  upstream_cdn_stale_cache_poison"
	@echo ""
