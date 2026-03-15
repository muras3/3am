# Incident Packet Remediation Plan

- Date: 2026-03-13
- Target: `origin/develop@3477f92`
- Scope:
  - incident packet design
  - receiver formation / ingest / evidence integration
  - packet contract and downstream operability
- This file is the single tracking document for incident packet remediation work.

## Goal

`incident packet` を「初回 anomalous batch の雑な snapshot」ではなく、
`継続 incident の canonical deterministic model` として成立させる。

## Problem Statement

現状の Receiver は incident を「一定時間継続する障害の箱」として扱っている。
一方で packet は新規 incident 時に一度だけ生成され、その後の traces / signals /
platform context を十分に反映しない。

より具体的には、現在の設計は:

- traces = incident を起こす trigger
- incident packet = incident の canonical model

であるべきところを、

- traces trigger 時点の初回 snapshot ≒ incident packet 本体

として扱ってしまっている。

このため、trigger と canonical model が分離されていない。

その結果、以下が起きる。

- incident の主語が不安定
- packet の situation / evidence / retrieval が stale になる
- diagnosis の入力が incident の現在状態を表さない
- UI に見える incident 像と実際の incident 進行がズレる

## Design Direction

採用する方向性は以下。

1. incident は `継続箱` として扱う
2. packet は immutable 初回 snapshot ではなく `導出 view` として扱う
3. traces / metrics / logs / platform events の蓄積状態から packet を再構成可能にする
4. formation は `environment + primaryService + timeWindow` だけでなく、
   dependency / route / platform context を使って改善する

### Implementation Shape

実装の基本方針は以下。

- Receiver が incident ごとの raw state を持つ
- raw state には少なくとも以下を含める
  - spans
  - metrics
  - logs
  - platform events
- packet は保存物そのものではなく、raw state からの導出 view として作る

考え方としては ambient read model と近い。
ただし ambient が「全体の最近の状態」を扱うのに対し、
incident packet は「incident 単位の canonical state」を扱う。

production 前提では、raw state は process memory だけでなく
DB-backed に持つ方向を基本とする。

## Tracking Rules

- 各課題は `Status` を持つ
- `Status` は `open`, `in_progress`, `done`, `deferred` のいずれか
- 実装判断やスコープ変更が起きたら、このファイルを更新する
- 完了判定は「コードを書いた」ではなく「完了条件を満たした」時点で行う

## Current Assessment

### Architecture

- incident lifecycle model: continuous incident
- packet lifecycle model: initial snapshot
- result: model mismatch

### Highest-Level Conclusion

最大のテーマは:

- `incident packet を canonical model としてまともに作れていない`

最大の構造欠陥は:

- `既存 incident で packet を再構成しない`

## Work Items

### A-1 Packet is not rebuilt for existing incidents

- Status: `open`
- Problem:
  - 新規 incident の時だけ `createPacket()` を呼ぶ
  - 既存 incident への attach 時は packet を更新しない
  - 既存 `packetId` を返して終わる
  - trigger と packet 本体を同一視している
- Locations:
  - [apps/receiver/src/transport/ingest.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/ingest.ts)
- Why this matters:
  - 後続 signal が packet に入らない
  - traces / triggers / scope が stale になる
  - metrics/logs だけ後追い append され、packet 内で新旧が混ざる
  - trace で incident を起こすこと自体は合理的だが、trace trigger 時点の snapshot を
    canonical packet として固定してしまっているのが問題
- Resolution approach:
  - packet を incident raw state から再構成する仕組みに変える
  - `createPacket()` を `rebuildPacket()` 系へ寄せる
  - traces / metrics / logs / platform events を incident 単位 raw state に保持する
  - 新しい signal/evidence が来るたびに raw state を更新し、packet を再導出する
- Priority: `P0`
- Done when:
  - 既存 incident に新しい trace signal が来た時、packet の `scope`, `triggerSignals`,
    `representativeTraces`, `pointers` が更新される
  - packet が incident の最新状態を表すことを integration test で確認できる

### A-2 Formation key ignores dependency

- Status: `open`
- Problem:
  - formation key が `environment + primaryService + 5min` に偏っている
  - ADR 0017 が期待する dependency-based grouping が未実装
- Locations:
  - [apps/receiver/src/domain/formation.ts](/Users/murase/project/3amoncall/apps/receiver/src/domain/formation.ts)
  - [docs/adr/0017-incident-formation-rules-v1.md](/Users/murase/project/3amoncall/docs/adr/0017-incident-formation-rules-v1.md)
- Why this matters:
  - 同 service / 別 dependency の障害を過剰 merge する
  - 同 dependency / 複数 service の障害を不要 split する
- Resolution approach:
  - `peer.service` を formation key に含める
  - route / platform context を補助キーとして評価する
  - merge より split 優先の方針を明確にコードへ反映する
- Priority: `P0`
- Done when:
  - dependency が異なる障害は別 incident になる
  - 同 dependency 起因の multi-service 波及を統合できるケースが test で確認できる

### A-3 platformEvents are dead code

- Status: `open`
- Problem:
  - `/v1/platform-events` は validate 後に `status: ok` を返すだけ
  - packet に platform event が一切入らない
- Locations:
  - [apps/receiver/src/transport/ingest.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/ingest.ts)
- Why this matters:
  - deploy/config/provider 起因の障害文脈が packet に残らない
  - `deploy-related?` の問いに deterministic fact で答えにくい
- Resolution approach:
  - platform event schema を定義する
  - `/v1/platform-events` で受けた event を incident raw state に保存する
  - incident attach 条件を決める
    - environment
    - service / deployment / route
    - time proximity
  - packet rebuild 時に platform facts を
    - situation context
    - evidence
    - retrieval
    に反映する
  - platform facts を diagnosis 入力として使える形にする
- Priority: `P1`
- Done when:
  - `/v1/platform-events` で受けた event が matching incident の packet に入る
  - UI / diagnosis から deploy/config/provider context を読める

### A-4 48h close rule is not implemented

- Status: `deferred`
- Problem:
  - close rule が ADR にあるが実装されていない
  - incident が永久 open 化しうる
- Locations:
  - [apps/receiver/src/domain/formation.ts](/Users/murase/project/3amoncall/apps/receiver/src/domain/formation.ts)
- Why this matters:
  - open incident list の意味が薄れる
  - evidence attach window と incident lifecycle が分離する
- Resolution approach:
  - background job または periodic sweeper を別設計する
- Priority: `P2`
- Done when:
  - close policy の owner, scheduler, state transition が ADR / 実装で定義される

### A-5 Evidence append is read-modify-write and can lose updates

- Status: `deferred`
- Problem:
  - metrics/logs evidence append が atomic ではない
  - concurrent batch で lost update の可能性がある
- Locations:
  - [apps/receiver/src/transport/ingest.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/ingest.ts)
  - [apps/receiver/src/storage/interface.ts](/Users/murase/project/3amoncall/apps/receiver/src/storage/interface.ts)
- Why this matters:
  - evidence が silently lost される
- Resolution approach:
  - storage adapter レベルで atomic append を設計する
- Priority: `P2`
- Done when:
  - concurrent append の race を adapter integration test で検知・防止できる

### B-1 primaryService depends on span order

- Status: `open`
- Problem:
  - `primaryService = spans[0].serviceName`
- Locations:
  - [apps/receiver/src/domain/packetizer.ts](/Users/murase/project/3amoncall/apps/receiver/src/domain/packetizer.ts)
- Why this matters:
  - packet の主語が入力順依存になる
  - edge / downstream / sibling span の並びで incident の顔が変わる
- Resolution approach:
  - `primaryService` を「incident の中心 service」と曖昧に扱わない
  - 現段階では `triggering anomalous service` を canonical 定義として採用する
  - つまり incident を新規作成させた anomalous signal の service を `primaryService` にする
  - business impact / blast radius / causal center の解釈は packet ではなく diagnosis 層に寄せる
  - 必要になれば将来 `triggeringService` と別の interpretation field を分離する
- Priority: `P0`
- Done when:
  - primaryService が `triggering anomalous service` として code/comment/test に明文化される
  - primaryService の選定が deterministic かつ order-independent になる
  - span 順序を変えても同じ packet scope になる test がある

### B-2 representativeTraces are just the first 10 spans

- Status: `open`
- Problem:
  - representativeTraces が代表選定になっていない
- Locations:
  - [apps/receiver/src/domain/packetizer.ts](/Users/murase/project/3amoncall/apps/receiver/src/domain/packetizer.ts)
- Why this matters:
  - LLM input の質が低い
  - 因果や異常度の強い trace を外しうる
- Resolution approach:
  - `representativeTraces` を deterministic ranking + diversity selection にする
  - まず全 span にスコアをつける
    - HTTP 5xx / 429 / exception を優先
    - duration 長大を加点
    - span status error を加点
    - dependency を持つ span を加点
  - 次に service / route / dependency の偏りを抑えながら選ぶ
  - 目的は「LLM が incident を誤解しにくい最小限の trace 集合」を渡すこと
  - 完璧な代表性ではなく、deterministic で説明可能な代表性をまず作る
- Priority: `P0`
- Done when:
  - representativeTraces の選定ロジックが code/comment/test で明文化される
  - 単純 slice ではなく ranking + diversity で選ばれている
  - 同一入力から毎回同じ representativeTraces が出る

### B-3 triggerSignals are frozen at initial packet creation

- Status: `open`
- Problem:
  - triggerSignals が初回 anomalous batch のみで固定される
- Locations:
  - [apps/receiver/src/domain/packetizer.ts](/Users/murase/project/3amoncall/apps/receiver/src/domain/packetizer.ts)
  - [apps/receiver/src/transport/ingest.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/ingest.ts)
- Why this matters:
  - incident の situation layer が stale になる
- Resolution approach:
  - `triggerSignals` を packet 作成時の一回計算ではなく、incident timeline から再導出する
  - incident に紐づく anomalous signals を保持する
  - packet rebuild 時に incident 全体の signal 群を集めて要約する
  - earliest / latest / strongest trigger の扱いを明示する
  - 目的は「incident を構成する異常パターンの要約」を packet に持たせることであり、
    初回 trigger 1発だけを固定することではない
- Priority: `P0`
- Done when:
  - 後続 signal attach 後に triggerSignals が更新される

### B-4 Evidence schema is too loose

- Status: `done`
- Completed: 2026-03-15 (Plan 6 / feat/plan6-typed-evidence)
- Resolution: ChangedMetricSchema + RelevantLogSchema (.strict()) replaced unknown[] in EvidenceSchema. appendEvidence → appendRawEvidence, rawState is sole source for evidence derivation via rebuildPacket.
- Problem:
  - metrics/logs/platform events が `unknown[]`
- Locations:
  - [packages/core/src/schemas/incident-packet.ts](/Users/murase/project/3amoncall/packages/core/src/schemas/incident-packet.ts)
- Why this matters:
  - downstream contract が弱い
  - UI / diagnosis / storage 間で drift を止めにくい
- Resolution approach:
  - minimal typed schemas を導入する
  - Packet evidence の canonical shape を固定する
  - evidence type ごとに relevance / ranking policy を分ける
    - trace
    - metric
    - log
    - platform event
  - 共通ルールは時間窓 + service/dependency 近接性とする
  - 重要度判定は evidence type ごとに別定義とする
  - 初期段階では単発/近傍異常を deterministic に扱う
  - ただし将来の cascade incident に備え、service を跨ぐ関連 evidence を
    保持・選定できる拡張余地を残す
- Priority: `P1`
- Done when:
  - changedMetrics / relevantLogs / platformEvents に最低限の typed schema がある
  - `unknown[]` が packet contract から消える
  - evidence selection policy が code/comment/test に明文化される

### B-5 Retrieval layer is mostly empty

- Status: `done`
- Completed: 2026-03-15 (Plan 6 / feat/plan6-typed-evidence)
- Resolution: rebuildPacket now populates metricRefs (unique metric names from rawState.metricEvidence) and logRefs (unique service:timestamp keys from rawState.logEvidence). All 4 pointer types (traceRefs, metricRefs, logRefs, platformLogRefs) are now populated from rawState.
- Problem:
  - traceRefs 以外が空で retrieval layer が成立していない
- Locations:
  - [apps/receiver/src/domain/packetizer.ts](/Users/murase/project/3amoncall/apps/receiver/src/domain/packetizer.ts)
  - [docs/adr/0018-incident-packet-semantic-sections.md](/Users/murase/project/3amoncall/docs/adr/0018-incident-packet-semantic-sections.md)
- Why this matters:
  - deep dive / replay / artifact fetch の土台がない
- Resolution approach:
  - retrieval layer を「最小参照メタデータ集」として定義する
  - raw data 全文ではなく、元データへ戻るための keys / ids / timestamps を持つ
  - trace には `traceId`, `spanId`, service, timestamp 相当を持つ
  - metric / log / platform event にも同様の再取得キーを定義する
  - packet を summary であると同時に evidence pointer として機能させる
- Priority: `P1`
- Done when:
  - retrieval layer に trace 以外の refs が入り、利用側テストがある

### B-6 severity is optional and usually unset

- Status: `open`
- Problem:
  - severity が canonical identity / observed signal metadata として入っていない
- Locations:
  - [packages/core/src/schemas/incident-packet.ts](/Users/murase/project/3amoncall/packages/core/src/schemas/incident-packet.ts)
- Why this matters:
  - observed signal の強さを packet 単体で安定して表せない
  - UI で signal-level urgency を出しづらい
  - ただし business severity / true incident severity を deterministic に決めることとは分ける必要がある
- Resolution approach:
  - `severity` を business impact の最終判断としては扱わない
  - packet に持つ場合は `observed signal severity` として定義する
  - 例:
    - 5xx / 429 / exception / duration / error burst から導出した deterministic signal strength
  - root cause significance や true incident severity の解釈は diagnosis / operator judgement に寄せる
  - field 名も必要に応じて `signalSeverity` 等へ見直す
- Priority: `P1`
- Done when:
  - packet または incident の canonical contract に observed signal severity が定義される
  - business severity と混同しないことが code/comment/schema で明文化される

## Observable Symptoms Mapping

### C-1 Incident subject is wrong

- Causes:
  - `B-1`

### C-2 Evidence inside the same incident does not line up

- Causes:
  - `A-1`
  - `B-3`

### C-3 Diagnosis input is stale

- Causes:
  - `A-1`
  - `B-2`

### C-4 Incident list granularity does not match operator intuition

- Causes:
  - `A-2`

### C-5 Deploy/config incidents have weak context

- Causes:
  - `A-2`
  - `A-3`

## Recommended Execution Order

1. `A-1`
2. `A-2`
3. `B-1`
4. `B-2`
5. `B-3`
6. `A-3`
7. `B-4`
8. `B-5`
9. `B-6`

## ADR Impact

### ADR updates needed

- [ADR 0018](/Users/murase/project/3amoncall/docs/adr/0018-incident-packet-semantic-sections.md)
  - update needed
  - reason:
    - packet を initial snapshot ではなく derived current-state view として明確化する
    - evidence / retrieval の責務を traces 以外も含めて具体化する

- [ADR 0017](/Users/murase/project/3amoncall/docs/adr/0017-incident-formation-rules-v1.md)
  - update needed
  - reason:
    - dependency を formation key に入れる方針を実装前提で明確化する
    - platform events を split / merge 補助情報としてどう使うか追記する

- [ADR 0023](/Users/murase/project/3amoncall/docs/adr/0023-instrumentation-minimum-requirements.md)
  - update needed
  - reason:
    - platform facts を packet/incident state に統合する時の minimum expectations を補う
    - observed signal severity と business severity を分ける方針を補足する

### New ADR likely needed

- `incident state and packet rebuild` ADR
  - new ADR recommended
  - reason:
    - 今回の remediation の中心は packetizer 単体修正ではなく、
      incident raw state から packet を再構成する lifecycle 変更だから
  - should define:
    - incident raw state の保管対象
    - packet rebuild のタイミング
    - packetId/version の扱い
    - latest packet と履歴の扱い

- `platform event contract` ADR
  - new ADR recommended
  - reason:
    - `/v1/platform-events` は受け口だけあり、semantic contract がまだ薄い
  - should define:
    - event types
    - required fields
    - incident attach policy
    - packet への反映先

### ADR work priority

1. new ADR: incident state and packet rebuild
2. update ADR 0018
3. update ADR 0017
4. new ADR: platform event contract
5. update ADR 0023

## Product Definition Alignment

### Overall judgment

この remediation plan は、現行の product definition / product concept と
大きくは矛盾しない。むしろ以下の点で整合している。

- 3amoncall は incident 単位で act-first に扱う reliability console である
- packet は diagnosis / UI の共通 deterministic input である
- trigger の解釈や root cause は LLM 側の責務である
- Evidence Studio は raw dump 置き場ではなく、AI 提案の裏取りの場である

### Why aligned

- packet を deterministic canonical model に寄せる方針は、
  `何が壊れているか / 今何をすべきか` を早く示す product 目的と整合する
- `primaryService` を triggering anomalous service に寄せる方針は、
  曖昧な business interpretation を packet に押し込まず、
  diagnosis 層へ解釈を渡す product role split と整合する
- evidence ranking / retrieval metadata を整える方針は、
  Evidence Studio を AI 提案の裏取りの場にする product definition と整合する

### Guardrails

この remediation が product definition とズレないために、以下を守る。

- packet 改善を自己目的化しない
- packet は operator の初動判断を速くするための基盤として扱う
- Evidence Studio を全量 raw dump UI にしない
- business severity / true root cause の解釈は deterministic packet に押し込まず、
  diagnosis / operator judgement に寄せる

## Definition of Success

以下が満たされた時、incident packet remediation は完了とみなす。

- packet が `initial snapshot` ではなく `latest canonical incident state` を表す
- packet 生成結果が span 順序に依存しない
- formation が dependency を考慮する
- platform facts が packet に入る
- evidence / retrieval contract が typed で安定している
- diagnosis と UI が stale packet ではなく current packet を前提に動く

## Acceptance Criteria

完了判定は「コードを書いた」ではなく、以下の観測結果で行う。

### 1. Packet conformance on real processing flow

- 実データ、または実データに近い validation シナリオを Receiver に流す
- 生成された incident packet を実際に取得し、このドキュメントの方針
  - trigger-based primaryService
  - rebuilt triggerSignals
  - ranked/diverse representativeTraces
  - typed evidence
  - retrieval metadata
  - platform facts
  に準拠していることを観測で確認する

### 2. Diagnosis quality check against ground truth

- 上記 packet をそのまま diagnosis に流す
- 既存 validation シナリオの ground truth と照合する
- 少なくとも採用対象シナリオ群について、期待する root cause / immediate action /
  major reasoning points と整合することを確認する

### 3. End-to-end operability check

- packet を UI で見た時に、incident の主語、主要 signal、代表 trace、
  metrics/logs/platform context が破綻なく読める
- packet から元データへの retrieval path が機能する

## Verification Plan

### Validation sources

- `validation/scenarios/*`
- ground truth template
- staging / Railway 上の curated OTLP injection

### Required verification outputs

- packet sample captures
- packet-to-ground-truth comparison notes
- diagnosis result vs ground truth comparison
- failures / mismatches list

## Residual Concerns (2026-03-15 verification)

以下は latest `develop` を使った scenario verification で確認された、
この plan 上まだ残しておくべき懸念事項である。

### R-1 Proper packet quality is improved, but duplicate noisy incidents can still appear

- Observation:
  - `secrets_rotation_partial_propagation` replay では、
    proper incident として
    - `primaryService = validation-web`
    - `affectedDependencies = ["sendgrid"]`
    - `triggerSignals` に `http_401`
    - `relevantLogs` に `sendgrid auth failure`
    を持つ packet が形成された
  - 一方で同じ replay から、別 incident として
    `primaryService = unknown_service:node`
    の noisy packet も形成された
- Why this matters:
  - proper packet 単体の品質は改善したが、
    operator から見た incident list のノイズはまだ残っている
  - diagnosis runner が「pending の先頭 incident」を処理する場合、
    noisy incident を先に診断してしまう
- Follow-up:
  - `unknown_service:node` 系 incident の split / suppress / lower-priority treatment を
    formation policy か verification gate で整理する
  - complete 判定は「proper packet が作れる」だけでなく、
    operator を誤誘導する duplicate/noisy incident が許容範囲内であることも見る

### R-2 Plan 5 is implemented in product code, but was not re-verified in the manual replay path

- Observation:
  - product code では `/v1/platform-events` ingest, typed packet schema, raw-state attach,
    `platformLogRefs` 生成まで入っている
  - ただし 2026-03-15 の manual replay では traces / metrics / logs だけを replay し、
    platform event ingest までは再実行していない
- Why this matters:
  - latest `develop` 上で proper packet が良くなっていても、
    platform facts の end-to-end verification は別途必要
- Follow-up:
  - scenario 4 の platform event path を含む replay / local run を再度実行し、
    packet と UI の両方で `platformEvents` を確認する

### R-3 Diagnosis backend operability remains environment-sensitive

- Observation:
  - `claude --print` backend は local environment で認証エラーになりうる
  - `codex exec` backend では diagnosis 自体は実行できた
  - ただし diagnosis runner は incident selector を持たず、
    pending の先頭 incident を処理する
- Why this matters:
  - packet quality の検証と diagnosis quality の検証が、
    CLI auth state や incident ordering の影響を受ける
- Follow-up:
  - verification 用には
    - stable CLI backend
    - target incident selection
    を持つ診断フローを別途用意する
  - complete 判定では「正しい packet を diagnosis に渡せたか」を明示的に確認する

### Quality bar

最終ゴールは、

- 「incident packet の shape が綺麗」

ではなく、

- 「実データ処理の結果として生成された incident packet がこの計画に準拠しており、
   その packet を LLM に流した結果が ground truth と整合する」

ことである。
