# ADR 0018: Incident Packet Semantic Sections

- Status: Accepted (amended 2026-03-13, 2026-03-17)
- Date: 2026-03-08
- Amended: 2026-03-13, 2026-03-17

## Context

ADR 0016 で `incident packet v1alpha` の最小構成は置いたが、Phase 1 実装を進めるには field 名より前に **packet がどの意味層を持つか** を固定する必要がある。

UI の最終レイアウトは今後も変わりうるため、packet を UI の見た目に直接従属させるのは避けたい。
一方で、Receiver・GitHub Actions・CLI・Console が同じ incident を指しているためには、packet が安定した canonical model を持つ必要がある。

## Decision

`incident packet` は **LLM input 用の canonical incident model** とする。
UI 専用 schema ではなく、以下の semantic sections を持つ。

> **Amendment (2026-03-13):** Packet は初回作成時の snapshot ではなく、**derived current-state view** である。新しい signals / evidence が attach されるたびに rebuild される。
>
> **Amendment (2026-03-17):** ADR 0030 は [ADR 0032](0032-telemetry-store-and-evidence-selection.md) により supersede された。Packet rebuild の入力は rawState ではなく、TelemetryStore から再選別された curated snapshot に変更。derived current-state view の原則は維持。

### 1. `identity`

incident を incident として識別するための層。

含めるもの:

- `incident_id`
- `packet_id`
- `schema_version`
- `status`
- `signalSeverity` (observed signal severity — deterministically derived, not business impact)
- `opened_at`
- `window`
- `scope`

> **Amendment (2026-03-13, Plan 3 / B-1):** `scope.primaryService` の canonical 定義は "the service that first exhibited anomalous behavior when the incident was created" とする。`createPacket()` で一度だけ確定し、以後の packet rebuild や `updatePacketWithSpans()` では変更しない。

> **Amendment (2026-03-13, Plan 3 / B-1):** `primaryService` の決定アルゴリズムは `selectPrimaryService(spans)` として固定する。anomalous spans を `startTimeMs asc -> serviceName asc` で sort し、先頭の `serviceName` を採用する。anomalous spans が存在しない場合のみ `spans[0].serviceName` に fallback する。

### 2. `situation`

incident の事実ベースの状況説明層。

含めるもの:

- visible symptoms
- affected services / routes / dependencies
- trigger signals
- impact surface
- deployment / config / traffic context の要約的事実

ここは **deterministic facts** を主とし、自然言語の完成要約までは packet の責務にしない。

### 3. `evidence`

incident を裏づける観測データの層。

含めるもの:

- changed metrics
- representative traces
- relevant logs
- platform facts

この層は packet の中核であり、LLM への主な入力となる。

> **Amendment (2026-03-13):** evidence の各 field は rebuild 時に再導出される。packet.evidence を rebuild の入力にしない。evidence type ごとの typed schema は今後の work item (B-4) で導入する。
>
> **Amendment (2026-03-17):** rebuild の入力は rawState ではなく TelemetryStore からの再選別結果 (curated snapshot)。詳細は [ADR 0032](0032-telemetry-store-and-evidence-selection.md) Decision 4/5 を参照。

### 4. `retrieval`

packet から raw data や保存済み artifact へ戻るための層。

含めるもの:

- trace refs
- log refs
- metric refs
- platform log refs
- optional URLs or storage keys

`retrieval` は UI deep dive と replay の両方を支える。

> **Amendment (2026-03-13):** retrieval refs も rebuild 時に再導出する。traces 以外の refs (logs, metrics, platform) の充填は今後の work item (B-5) で実装する。
>
> **Amendment (2026-03-17):** retrieval refs は TelemetryStore 上のデータへの参照として機能する。詳細は [ADR 0032](0032-telemetry-store-and-evidence-selection.md)。

## Explicit Non-Goals

`incident packet` には、以下を含めない。

- `immediate_action`
- `do_not`
- `root_cause_hypothesis`
- `why_this_action`
- `confidence_assessment`
- UI 固有の card 名や表示順

これらは `diagnosis result` または UI view model の責務であり、packet 自体には入れない。

## Rationale

- packet の元の目的は **LLM に渡すための deterministic incident input** である
- recommendation や reasoning を packet に入れると、Receiver が LLM 的責務を持ってしまう
- semantic sections を固定すれば、UI が多少変わっても packet の安定性を保てる
- Console, CLI, GitHub Actions が同じ canonical model を参照できる
- `primaryService` を triggering service として固定することで、UI headline / diagnosis prompt / formation key comparison の主語を span 順序から切り離せる

## Consequences

- Receiver は `identity / situation / evidence / retrieval` を作る責務を持つ
- `diagnosis result` は packet とは別の出力契約として定義する必要がある
- UI は packet をそのまま描画するのではなく、packet を土台に表示モデルを構成する
- field 詳細は今後更新されうるが、semantic sections 自体は Phase 1 の基礎契約になる
- `scope.primaryService` は incident 作成時の triggering service を保持し、後続 signal では更新しない
- UI / diagnosis / formation key 側も、この `primaryService` を incident の canonical subject として扱う

> **Amendment (2026-03-13):** Packet は derived view であるため、同一 packetId で内容が更新される。packetId は latest canonical view を指す stable identifier である。
>
> **Amendment (2026-03-17):** ADR 0030 は [ADR 0032](0032-telemetry-store-and-evidence-selection.md) により supersede。rebuild の仕組みは TelemetryStore → curated snapshot → packet に変更されたが、packetId の stable identifier としての性質は維持。

## Related

- [0016-incident-packet-v1alpha.md](/Users/murase/project/3amoncall/docs/adr/0016-incident-packet-v1alpha.md)
- [0017-incident-formation-rules-v1.md](/Users/murase/project/3amoncall/docs/adr/0017-incident-formation-rules-v1.md)
- [incident-console-v3.html](/Users/murase/project/3amoncall/docs/mock/incident-console-v3.html)
