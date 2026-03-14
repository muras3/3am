# Validation stack targeting Railway staging receiver.
#
# Quick start:
#   cp .env.staging.example .env.staging   # fill in RECEIVER_ENDPOINT + RECEIVER_AUTH_TOKEN
#   make up
#   make run SCENARIO=third_party_api_rate_limit_cascade
#   make down

COMPOSE_FILES := -f docker-compose.yml -f docker-compose.staging.yml
ENV_FILE      ?= .env.staging
DC            := docker compose $(COMPOSE_FILES) --env-file $(ENV_FILE)

.PHONY: help check-env up down run ps logs

help:
	@echo "Available scenarios:"
	@ls scenarios/
	@echo ""
	@echo "Targets:"
	@echo "  make check-env              Verify .env.staging has required values"
	@echo "  make up                     Start validation stack (uses Railway receiver)"
	@echo "  make run SCENARIO=<id>      Run a scenario end-to-end"
	@echo "  make down                   Tear down all containers"
	@echo "  make ps                     Show container status"
	@echo "  make logs                   Tail otel-collector logs"

check-env:
	@test -f $(ENV_FILE) || \
	  (echo "ERROR: $(ENV_FILE) not found."; \
	   echo "  cp .env.staging.example .env.staging"; \
	   echo "  Then fill in RECEIVER_ENDPOINT and RECEIVER_AUTH_TOKEN"; \
	   exit 1)
	@grep -q 'RECEIVER_ENDPOINT=https://' $(ENV_FILE) || \
	  (echo "ERROR: RECEIVER_ENDPOINT must be https://....up.railway.app (no trailing slash)"; exit 1)
	@grep -qE 'RECEIVER_AUTH_TOKEN=[a-f0-9]{10}' $(ENV_FILE) || \
	  (echo "ERROR: RECEIVER_AUTH_TOKEN missing or too short — generate with: openssl rand -hex 32"; exit 1)
	@echo "OK: $(ENV_FILE) looks valid"
	@echo "  endpoint: $$(grep RECEIVER_ENDPOINT $(ENV_FILE) | cut -d= -f2)"

up: check-env
	$(DC) up -d

down:
	$(DC) down

run: check-env
	@test -n "$(SCENARIO)" || \
	  (echo "Usage: make run SCENARIO=<id>"; echo ""; echo "Available:"; ls scenarios/; exit 1)
	@ls scenarios/$(SCENARIO) > /dev/null 2>&1 || \
	  (echo "ERROR: Unknown scenario '$(SCENARIO)'"; echo "Available:"; ls scenarios/; exit 1)
	$(DC) exec scenario-runner node run.js $(SCENARIO)
	@echo ""
	@echo "Artifacts written to: out/runs/"

ps:
	$(DC) ps

logs:
	$(DC) logs -f otel-collector
