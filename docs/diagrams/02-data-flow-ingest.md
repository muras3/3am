# Data Flow — OTLP Trace Ingest

> Primary data path: from OTel SDK to incident creation or attachment.

```mermaid
graph TB
  subgraph "User's Application"
    OTel[OTel SDK]
  end

  OTel -->|"POST /v1/traces<br/>Bearer Auth, protobuf/JSON, 1MB limit"| Ingest

  subgraph "Receiver (Hono)"
    Ingest[Ingest Handler] -->|decode| Extract[extractSpans]
    Extract --> SpanBuf[(SpanBuffer<br/>L1 ambient cache<br/>1000 cap, 5min TTL)]
    Extract -->|"filter: isAnomalous<br/>(5xx, 429, ERROR, >5s, exception)"| Anomalous{Anomalous?}

    Anomalous -->|No| Done[Discard from incident path]
    Anomalous -->|Yes| TriggerSel[selectIncidentTriggerSpans]

    TriggerSel -->|"SERVER+429 excluded<br/>CLIENT+429 included<br/>repeated 401/403 = auth failure"| FormKey[buildFormationKey]

    FormKey -->|"env + service + dependency + 5min window"| Attach{Existing<br/>incident?}

    Attach -->|"Yes: shouldAttachToIncident"| Rebuild[rebuildPacket<br/>from rawState]
    Attach -->|"No: new incident"| Create[createPacket]

    Create --> Store[(StorageDriver<br/>createIncident)]
    Rebuild --> Store

    Create --> ThinEvt[saveThinEvent]
    ThinEvt --> Dispatch[dispatchThinEvent]
  end

  Dispatch -->|"workflow_dispatch<br/>(best-effort, failure logged)"| GHA[GitHub Actions]

  classDef storage fill:#e8e8ff,stroke:#666
  classDef decision fill:#fff3cd,stroke:#666
  classDef external fill:#f0f0f0,stroke:#999

  class SpanBuf,Store storage
  class Anomalous,Attach decision
  class OTel,GHA external
```

<!-- Comment:
  isAnomalous と isIncidentTrigger は別概念。
  isAnomalous = "何かおかしい span" (全部 SpanBuffer + rawState に入る)
  isIncidentTrigger = "新しい incident を開くべき span"
    → SERVER+429 は自分がrate-limitしてるだけなので trigger にならない
    → CLIENT+429 は外部依存が返してきた → trigger になる
  この区別が ADR 0008 の「LLM なしのグルーピング」の肝。
-->
