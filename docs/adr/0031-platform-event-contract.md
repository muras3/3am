# ADR 0031: Platform Event Contract

- Status: Proposed
- Date: 2026-03-13

## Context

`/v1/platform-events` は受信口だけ存在し、validate 後に `{ status: "ok" }` を返す no-op のままになっている。結果として deploy / config / provider 側の変更や障害文脈が incident packet に入らず、Console や diagnosis が incident の外部変化を参照できない。

ADR 0030 により packet は incident raw state からの derived view と定義された。platform events もこの原則に従い、ingest path から packet へ直接追記せず raw state に保存し、rebuild で canonical packet に反映する必要がある。

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

rebuild は `rawState.platformEvents` から以下を導出する。

- `packet.evidence.platformEvents`: typed event object の配列
- `packet.pointers.platformLogRefs`: re-fetch 用の最小参照キー

`platformLogRefs` の導出規則:

- `eventId` があればそれを使う
- なければ `${timestamp}:${eventType}:${service ?? provider ?? "global"}` を使う

この ref は deterministic であり、同一 raw state から同一順序で同じ値が得られなければならない。

### 4. Storage and ingest boundary

- ingest path は platform event を incident raw state にのみ追加する
- packet への直接 append は禁止
- attach 後は `rebuildPacket()` を実行し、latest canonical packet を更新する

## Consequences

- `GET /api/incidents/:id` から deploy / provider context を読める
- platform event attach は deterministic になり、複数 incident への二重 attach を避けられる
- rebuild contract を維持したまま、platform context を packet の evidence / retrieval layer に統合できる

## Related

- [ADR 0030: Incident State and Packet Rebuild](0030-incident-state-and-packet-rebuild.md)
- [ADR 0018: Incident Packet Semantic Sections](0018-incident-packet-semantic-sections.md)
- [ADR 0022: Ingest Protocol and Platform Log Separation](0022-ingest-protocol-and-platform-log-separation.md)
- [Plan 5: Platform Events Integration (A-3)](../plans/plan-5-platform-events-a3.md)
