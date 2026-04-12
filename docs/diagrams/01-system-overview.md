# System Overview — 3am

> High-level system context: who talks to what, and where the boundaries are.

```mermaid
C4Context
  title 3am System Context

  Person(operator, "On-Call Engineer", "Views incidents, reads diagnosis, asks AI copilot")

  System(receiver, "Receiver", "Hono backend — OTLP ingest, anomaly detection, incident formation, packetizer, Console API, canonical store")
  System(console, "Console SPA", "React 19 + Vite — 3-col incident board, Evidence Studio, AI Copilot chat")

  System_Ext(app, "User's Application", "OTel SDK instrumented — emits traces, metrics, logs")
  System_Ext(ghactions, "GitHub Actions", "Stateless diagnosis worker — fetch packet, run LLM, callback result")
  System_Ext(claude, "Claude API", "Anthropic LLM — claude-sonnet-4-6 for diagnosis, claude-haiku-4-5 for copilot")

  Rel(app, receiver, "OTLP/HTTP + Bearer", "traces, metrics, logs, platform-events")
  Rel(receiver, ghactions, "workflow_dispatch", "thin event (incident_id, packet_id)")
  Rel(ghactions, receiver, "GET /api/packets/:id", "fetch packet")
  Rel(ghactions, claude, "messages.create", "v5 SRE prompt")
  Rel(ghactions, receiver, "POST /api/diagnosis/:id", "DiagnosisResult callback")
  Rel(receiver, claude, "messages.create", "AI Copilot (haiku-4-5)")
  Rel(operator, console, "Views incidents")
  Rel(console, receiver, "/api/*", "same-origin BFF, served by Receiver")
```

<!-- Comment:
  Receiver が中心。診断用の LLM API キーは GitHub Actions 側にのみ存在し、
  Receiver は持たない (ADR 0015)。ただし AI Copilot (haiku) は
  Receiver が直接呼ぶ (ADR 0027)。
  Console は Receiver から同一オリジンで serve される (ADR 0028) ため、
  Bearer token はブラウザバンドルに含まれない。
-->
