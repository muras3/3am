# ADR 0035: Pluggable LLM Execution Paths

- Status: Accepted
- Date: 2026-04-01
- Amends: ADR 0027, ADR 0034

## Context

ADR 0034 moved diagnosis execution into the Receiver and assumed a server-side Anthropic credential. That simplified deployment, but it blocks two important operator paths:

1. engineers who already pay for Claude Code or Codex subscriptions and do not want to mint a separate API key
2. operators who want the Receiver to stay deployed while diagnosis runs locally and is posted back

This project also needs a consistent execution model across stage 1 diagnosis, stage 2 narrative generation, and AI chat.

## Decision

We introduce a pluggable provider layer in `@3amoncall/diagnosis`.

- all model execution goes through provider resolution instead of Anthropic-only calls
- the primary local-subscription providers are `claude-code` and `codex`
- `automatic` mode remains server-side and forbids subprocess/local-host providers by default
- `manual` mode runs through a local bridge/CLI path and posts results back to the Receiver

Provider priority for auto-detect is:

1. `anthropic`
2. `claude-code`
3. `codex`
4. `openai`
5. `ollama`

## Consequences

- Claude Code and Codex become first-class manual execution paths
- Console and CLI can share one local execution bridge
- Receiver keeps one persistence path regardless of where execution happens
- subprocess providers must stay gated off in server-side runtimes unless explicitly enabled

## Security Notes

- subprocess providers are the preferred local-subscription path, but they are not enabled for automatic Receiver execution
- local bridge usage must assume localhost attack surface exists and should be tightened separately where needed
- large prompts should avoid shell interpolation; provider implementations must use direct process invocation
