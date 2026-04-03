# Diagnosis Flow — Sequence Diagram

> Request lifecycle: thin event dispatch → LLM diagnosis → result callback.

```mermaid
sequenceDiagram
  participant R as Receiver
  participant GH as GitHub Actions
  participant CLI as @3am/cli
  participant LLM as Claude API<br/>(sonnet-4-6)

  Note over R: Incident created, packet stored

  R->>GH: workflow_dispatch<br/>{event_id, incident_id, packet_id}
  activate GH

  GH->>R: GET /api/packets/:packetId
  R-->>GH: IncidentPacket (JSON)

  GH->>CLI: node cli --packet packet.json<br/>--callback-url /api/diagnosis/:id
  activate CLI

  CLI->>CLI: IncidentPacketSchema.parse()
  CLI->>CLI: buildPrompt(packet)<br/>v5 7-step SRE prompt

  CLI->>LLM: messages.create<br/>max_tokens: 8192
  activate LLM

  Note over LLM: 1. Identify incident window<br/>2. Map dependency chain<br/>3. Trace root cause<br/>4. Propose immediate action<br/>5. Assess confidence

  LLM-->>CLI: Response (text blocks)
  deactivate LLM

  CLI->>CLI: parseResult()<br/>JSON + markdown fallback

  alt Callback URL provided
    CLI->>R: POST /api/diagnosis/:id<br/>Bearer Auth + DiagnosisResult
    activate R
    R->>R: storage.appendDiagnosis()
    R-->>CLI: 200 OK
    deactivate R
  end

  CLI-->>GH: Exit 0 + stdout result
  deactivate CLI
  deactivate GH

  Note over R: Console polls → diagnosisResult now available
```

<!-- Comment:
  GitHub Actions は完全に stateless。canonical data は全て Receiver に住む。
  CLI は GitHub Actions 以外からも実行可能（ローカル開発、検証パイプライン）。
  retry: 429/502/503/529 に対して最大2回リトライ、exponential backoff。
  parse 失敗や 4xx client error にはリトライしない (ADR 0019 v2)。
-->
