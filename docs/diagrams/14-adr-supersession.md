# ADR Supersession & Amendment Map

> How architectural decisions relate to each other.

```mermaid
graph LR
  subgraph "Branching Strategy"
    ADR0006["ADR 0006<br/>PR-only to main<br/>❌ Superseded"]
    ADR0010["ADR 0010<br/>develop branch strategy<br/>✅ Accepted"]
    ADR0006 -->|"superseded by"| ADR0010
  end

  subgraph "Data Storage Evolution"
    ADR0013["ADR 0013<br/>StorageDriver interface<br/>✅ Accepted"]
    ADR0024["ADR 0024<br/>Drizzle ORM impl<br/>✅ Accepted"]
    ADR0029["ADR 0029<br/>SpanBuffer ambient<br/>✅ Accepted (amended)"]
    ADR0030["ADR 0030<br/>rawState + rebuild<br/>❌ Superseded"]
    ADR0031["ADR 0031<br/>Platform event contract<br/>📝 Proposed (amended)"]
    ADR0032["ADR 0032<br/>TelemetryStore<br/>📝 Proposed"]

    ADR0013 --> ADR0024
    ADR0024 --> ADR0030
    ADR0030 -->|"superseded by"| ADR0032
    ADR0032 -->|"amends"| ADR0029
    ADR0032 -->|"amends"| ADR0031
  end

  subgraph "Packet & Diagnosis"
    ADR0016["ADR 0016<br/>Packet v1alpha<br/>✅ Accepted"]
    ADR0018["ADR 0018<br/>Semantic sections<br/>✅ Accepted (amended)"]
    ADR0019["ADR 0019<br/>DiagnosisResult v2<br/>✅ Accepted"]
    ADR0020["ADR 0020<br/>Thin event contract<br/>✅ Accepted (amended)"]
    ADR0021["ADR 0021<br/>Receiver + GHA integration<br/>✅ Accepted"]

    ADR0016 --> ADR0018
    ADR0018 --> ADR0020
    ADR0020 --> ADR0021
    ADR0032 -->|"amends"| ADR0018
    ADR0032 -->|"amends"| ADR0020
  end

  subgraph "Formation & Detection"
    ADR0007["ADR 0007<br/>Packet in Receiver<br/>✅ Accepted"]
    ADR0008["ADR 0008<br/>No-LLM grouping<br/>✅ Accepted"]
    ADR0017["ADR 0017<br/>Formation rules v1<br/>✅ Accepted"]

    ADR0007 --> ADR0008
    ADR0008 --> ADR0017
  end

  classDef accepted fill:#d4edda,stroke:#2e7d52
  classDef superseded fill:#ffcccc,stroke:#cc0000
  classDef proposed fill:#cce5ff,stroke:#0066cc

  class ADR0010,ADR0013,ADR0024,ADR0016,ADR0018,ADR0019,ADR0020,ADR0021,ADR0007,ADR0008,ADR0017 accepted
  class ADR0006,ADR0030 superseded
  class ADR0031,ADR0032 proposed
  class ADR0029 accepted
```

<!-- Comment:
  ADR 0032 が最も影響範囲が広い:
    - ADR 0030 を完全に置き換え (rawState 廃止)
    - ADR 0029 を修正 (SpanBuffer = L1 cache に降格)
    - ADR 0031 を修正 (platform events → TelemetryStore に移動)
    - ADR 0018 を修正 (packet rebuild source: rawState → TelemetryStore snapshot)
    - ADR 0020 を修正 (packet_id → latest canonical view)

  現在 "Proposed" なのは ADR 0031 と 0032。
  これらの実装が Phase 1 の残りの大きな作業。
-->
