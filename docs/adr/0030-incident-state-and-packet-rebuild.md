# ADR 0030: Incident State and Packet Rebuild

- Status: Superseded by [ADR 0032](0032-telemetry-store-and-evidence-selection.md)
- Date: 2026-03-13

## Context

ADR 0018 は incident packet の semantic sections (identity / situation / evidence / retrieval) を定義した。しかし現在の実装では packet は incident 作成時に一度だけ生成され、以降の signals / evidence は packet に十分に反映されない。

具体的には:

- 新規 incident 作成時に `createPacket()` が呼ばれ、初回 batch の spans のみから packet を生成する
- 既存 incident への attach 時は packet を更新しない（既存の `packetId` を返すだけ）
- metrics / logs は `appendEvidence()` で packet.evidence に直接追記されるが、spans / anomalous signals は追加されない
- triggerSignals は初回 batch の anomalous spans からのみ構成され、後続 signals が反映されない

この結果、incident packet は「初回 anomalous batch の snapshot」であり、「incident の canonical current state」を表していない。

## Decision

### 1. Incident Raw State を導入する

Incident ごとに raw state を保持する。raw state は packet rebuild の **唯一の正本 (single source of truth)** とする。

```
IncidentRawState {
  spans: ExtractedSpan[]          // incident に紐づく全 spans
  anomalousSignals: AnomalousSignal[]  // 全 anomalous signals
  metricEvidence: unknown[]       // raw metric data（将来 typed 化: Plan 6/B-4）
  logEvidence: unknown[]          // raw log data（将来 typed 化: Plan 6/B-4）
  platformEvents: unknown[]       // placeholder（将来活性化: Plan 5/A-3）
}
```

raw state は `Incident` の一部として storage に永続化する。

### 2. Packet は raw state からの導出 view とする

Packet は raw state から毎回再構成 (rebuild) される derived view である。

- rebuild の入力は `IncidentRawState` のみ
- `packet.evidence` を rebuild の入力にしない — packet.evidence は raw state からの出力
- rebuild は新しい signal / evidence が attach されるたびに実行する

導出ルール:
- `rawState.spans` → `scope` (services, routes, dependencies), `window`, `evidence.representativeTraces`, `pointers.traceRefs`
- `rawState.anomalousSignals` → `triggerSignals` (signal type + entity で dedup, earliest firstSeenAt を保持)
- `rawState.metricEvidence` → `evidence.changedMetrics`, `pointers.metricRefs`
- `rawState.logEvidence` → `evidence.relevantLogs`, `pointers.logRefs`
- `rawState.platformEvents` → `evidence.platformEvents`, `pointers.platformLogRefs`

### 3. packetId は latest canonical view を指す stable identifier

- `packetId` は incident 作成時に一度発行され、rebuild しても変わらない
- `/api/packets/:packetId` は常に **latest view** を返す
- thin event の `packet_id` は「trigger 時点の latest packet」を意味する
- diagnosis runtime が取得する packet は latest view — diagnosis 実行中に rebuild が起きうる (eventual consistency)
- diagnosis result の `metadata.packet_id` は「diagnosis が読んだ時点の packet」を指す

**ADR 0020 との関係:**
- ADR 0020 は `packet_id` を「diagnosis runtime が取得すべき packet の識別子」と定義している
- 本 ADR により `packet_id` は snapshot handle ではなく、latest view への stable reference になる
- これは thin event の再現性に影響する: 同じ thin event を再処理した場合、取得される packet 内容は trigger 時点と異なりうる
- Phase 1 ではこの eventual consistency を許容する。ADR 0020 にも amendment を追記して明示する

### 4. Generation tracking

rebuild 回数を `generation` counter で追跡する。

- 初回作成: generation = 1
- 各 rebuild: generation を increment
- diagnosis result の `metadata` に `packet_generation` を記録可能にする（Phase 1 では optional）

### 5. Latest packet のみ保持

Phase 1 では latest packet のみ保持する。旧世代の packet は保持しない。

### 6. appendEvidence の段階的移行

raw state への一本化は段階的に進める。

**Plan 1 (A-1/B-3) の最小スコープ:**
- `spans` と `anomalousSignals` を raw state に正本化する — これが Plan 1 の核心
- `appendEvidence()` は **そのまま残す** — metrics/logs は従来通り packet.evidence に直接追記
- rebuild 時、metrics/logs/platform は packet.evidence から読む (暫定的に raw state と packet.evidence の二重読み)
- この段階では raw state の `metricEvidence` / `logEvidence` / `platformEvents` は空のまま

**Plan 6 (B-4) 以降:**
- `appendEvidence()` を `appendRawEvidence()` に置き換え
- metrics/logs を raw state に移行し、rebuild が raw state のみから evidence を導出するように変更
- typed schema (ChangedMetricSchema, RelevantLogSchema) を同時に導入
- この段階で raw state が全 evidence type の唯一の正本になる

**Plan 5 (A-3):**
- platform events を raw state に追加し、rebuild で packet に反映

この段階分けにより:
- Plan 1 は spans/signals の正本化に集中できる
- storage 契約の大規模変更 (appendEvidence 廃止) は typed 化と同時に行い、型の緩さが storage に移るだけの状態を避ける
- 各 plan のスコープが明確になる

## Storage Interface Changes

**Plan 1 (A-1/B-3) — 最小変更:**
```
// 新規メソッド
appendSpans(incidentId, spans: ExtractedSpan[]): void
appendAnomalousSignals(incidentId, signals: AnomalousSignal[]): void
getRawState(incidentId): IncidentRawState | null

// 既存メソッド — そのまま残す
appendEvidence()  // metrics/logs は従来通り packet.evidence に直接追記
```

**Plan 6 (B-4) 以降 — 完全移行:**
```
// 新規メソッド (Plan 6 で追加)
appendRawEvidence(incidentId, { metrics?, logs? }): void

// 廃止 (Plan 6 で)
appendEvidence()  →  appendRawEvidence() + rebuildPacket() に置き換え
```

## Rebuild Trigger Points

| Event | Action |
|-------|--------|
| 新規 incident 作成 | initial rebuild (generation = 1) |
| 既存 incident への trace attach | appendSpans + appendAnomalousSignals → rebuild |
| metrics evidence 受信 | appendRawEvidence → rebuild |
| logs evidence 受信 | appendRawEvidence → rebuild |
| platform events 受信 (将来) | appendRawEvidence → rebuild |

## Eventual Consistency

diagnosis runtime は packet fetch → LLM 呼び出し → result callback の間に packet が rebuild されうる。Phase 1 ではこれを許容する。

- diagnosis は「読んだ時点の packet」で診断する
- rebuild による packet 更新は次回の diagnosis trigger で反映される
- generation counter により、どの世代で診断したかを追跡可能

将来の強化案（Phase 1 では実装しない）:
- diagnosis 開始時の generation を記録し、result callback 時に generation が変わっていたら再診断を検討
- packet snapshot を generation ごとに保持して diff を出す

## Rationale

- packet を derived view にすることで、後続 signals が自然に反映される
- raw state を single source of truth にすることで、rebuild の入力が明確になり二重管理を防ぐ
- packetId を stable にすることで、thin event / diagnosis / UI の既存参照が壊れない
- generation tracking により eventual consistency の影響を将来的に管理可能にする

## Consequences

**Plan 1 (即時):**
- `createPacket()` は `rebuildPacket()` に置き換わる
- `Incident` に `rawState: IncidentRawState` が追加される
- storage adapter に `appendSpans` / `appendAnomalousSignals` / `getRawState` が追加される
- Drizzle adapters は raw state を JSON column として保持する
- 既存 incident attach 時のコードパスが「return existing packetId」から「append → rebuild → upsert」に変わる
- `appendEvidence()` は **そのまま残る** — metrics/logs は暫定的に従来パスを維持

**Plan 6 以降 (段階的):**
- `appendEvidence()` が `appendRawEvidence()` に置き換わる
- metrics/logs が raw state に移行し、rebuild の入力が完全に raw state に一本化される
- typed schema 導入と同時に移行することで、型の緩さが storage に移るだけの状態を避ける

## Related

- [ADR 0018: Incident Packet Semantic Sections](0018-incident-packet-semantic-sections.md)
- [ADR 0016: Incident Packet v1alpha](0016-incident-packet-v1alpha.md)
- [ADR 0020: Thin Event Contract](0020-thin-event-contract-for-diagnosis-trigger.md)
- [ADR 0021: Receiver and GitHub Actions Integration](0021-receiver-and-github-actions-integration.md)
- [Remediation Plan](../plans/2026-03-13-incident-packet-remediation-plan.md)
