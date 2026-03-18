# ADR 0031: Platform Event Contract

- Status: Accepted (amended 2026-03-17)
- Date: 2026-03-13
- Amended: 2026-03-17

## Context

`/v1/platform-events` は受信口だけ存在し、validate 後に `{ status: "ok" }` を返す no-op のままになっている。結果として deploy / config / provider 側の変更や障害文脈が incident packet に入らず、Console や diagnosis が incident の外部変化を参照できない。

ADR 0030 により packet は incident raw state からの derived view と定義された。platform events もこの原則に従い、ingest path から packet へ直接追記せず raw state に保存し、rebuild で canonical packet に反映する必要がある。

> **Amendment (2026-03-17):** ADR 0030 は [ADR 0032](0032-telemetry-store-and-evidence-selection.md) により supersede。platform events の保存先は incident rawState ではなく TelemetryStore (`telemetry_platform_events` テーブル)。packet rebuild の原則（derived current-state view）は維持。以下の Decision 3/4 で `rawState` に言及している箇所は TelemetryStore に読み替えること。

## Decision

### 1. Canonical platform event shape

platform event は以下の typed object を canonical contract とする。

Required:

- `eventType`: `deploy` | `config_change` | `provider_incident` | `scaling_event`
- `timestamp`: event 発生時刻 (ISO string)
- `environment`
- `description`

Optional:

- `service`
- `deploymentId`
- `releaseVersion`
- `provider`
- `eventId`
- `details`

`details` は追加の provider-specific metadata を保持する object とする。

### 2. Attach policy

platform event の attach は per-event で評価し、複数 incident への attach は行わない。

候補条件:

1. incident は `open`
2. `environment` が一致する
3. `service` 指定あり:
   incident `scope.affectedServices` にその service を含む
4. `service` 指定なし:
   environment 一致のみで候補に残す
5. `window.start <= event.timestamp <= window.end`

候補が複数ある場合は以下の順で 1 件を選ぶ:

1. `abs(window.detect - event.timestamp)` 最小
2. `openedAt` が新しい incident を優先
3. `incidentId` lex

候補が 0 件なら attach しない。

### 3. Packet projection

> **Amendment (2026-03-17):** rebuild の入力は `rawState.platformEvents` ではなく、TelemetryStore から再選別された curated snapshot。詳細は [ADR 0032](0032-telemetry-store-and-evidence-selection.md) Decision 4/5。

rebuild は以下を導出する。

- `packet.evidence.platformEvents`: typed event object の配列
- `packet.pointers.platformLogRefs`: re-fetch 用の最小参照キー

`platformLogRefs` の導出規則:

- `eventId` があればそれを使う
- なければ `${timestamp}:${eventType}:${service ?? provider ?? "global"}` を使う

この ref は deterministic であり、同一 raw state から同一順序で同じ値が得られなければならない。

### 4. Storage and ingest boundary

> **Amendment (2026-03-17):** 保存先は incident rawState ではなく TelemetryStore。ingest → TelemetryStore 保存 → 該当 incident の curated snapshot 再選別 → packet rebuild。

- ingest path は platform event を TelemetryStore に保存する（incident rawState ではない）
- packet への直接 append は禁止
- 該当 incident の time window に該当する新規 platform event の到着で curated snapshot を再選別し、`rebuildPacket()` を実行して latest canonical packet を更新する

## Consequences

- `GET /api/incidents/:id` から deploy / provider context を読める
- platform event attach は deterministic になり、複数 incident への二重 attach を避けられる
- rebuild contract を維持したまま、platform context を packet の evidence / retrieval layer に統合できる

## Related

- [ADR 0030: Incident State and Packet Rebuild](0030-incident-state-and-packet-rebuild.md) — superseded by ADR 0032
- [ADR 0032: TelemetryStore](0032-telemetry-store-and-evidence-selection.md)
- [ADR 0018: Incident Packet Semantic Sections](0018-incident-packet-semantic-sections.md)
- [ADR 0022: Ingest Protocol and Platform Log Separation](0022-ingest-protocol-and-platform-log-separation.md)
- [Plan 5: Platform Events Integration (A-3)](../plans/plan-5-platform-events-a3.md)

## Amendment Summary (2026-03-17)

[ADR 0032](0032-telemetry-store-and-evidence-selection.md) により、以下を変更:

- **保存先**: incident rawState → TelemetryStore (`telemetry_platform_events` テーブル)
- **Canonical shape**: eventType, timestamp, environment, description 等は維持
- **Snapshot 更新**: 該当 incident への新規 platform event 到着ごとに curated snapshot を再選別・更新し packet rebuild を駆動（作成時のみではない）
- **本文の読み替え**: Decision 3/4 の `rawState` 参照は TelemetryStore に読み替え。各セクション冒頭の amendment 注記を参照
