# UI Fit-Gap and Implementation Plan

- Date: 2026-03-12
- Inputs:
  - [product-definition-v0-2026-03-12.md](/Users/murase/project/3amoncall/docs/design/product-definition-v0-2026-03-12.md)
  - [product-definition-impact-report-2026-03-12.md](/Users/murase/project/3amoncall/docs/design/product-definition-impact-report-2026-03-12.md)
  - [proof-first-ui-feasibility-2026-03-12.md](/Users/murase/project/3amoncall/docs/design/proof-first-ui-feasibility-2026-03-12.md)
  - [main-board-v3-gap-review-2026-03-12.md](/Users/murase/project/3amoncall/docs/design/main-board-v3-gap-review-2026-03-12.md)
  - [main-board-v4.html](/Users/murase/project/3amoncall/docs/mock/main-board-v4.html)
  - [normal-mode-v1.html](/Users/murase/project/3amoncall/docs/mock/normal-mode-v1.html)
  - current console / receiver / schema code on `develop`
- Purpose:
  - target mock と現行実装の差分を冷静に整理する
  - 「UI だけで行ける範囲」と「そうではない範囲」を分ける
  - 実装順を決める

## Executive Summary

結論は次の通りである。

1. `main-board-v4` の incident workspace 方向は正しい
2. `normal-mode-v1` により、product definition の二面性はかなり具体化できた
3. ただし **UI だけで実現できるのは incident workspace の再編集まで** であり、
   `normal mode` と `ambient surface` は現状 API / storage / read model だけでは不足する
4. 最初にやるべきことは **UI view model 層の導入** であり、schema 破壊ではない
5. その次に、`ambient surface read model` と `chat context` の補強が必要になる

つまり、実装の筋は

1. target view model を定義する
2. current develop で作れる incident workspace を先に作る
3. その後に normal mode の read path を足す
4. 最後に diagnosis / packet 契約の拡張を行う

である。

## Target Product Shape

mock 2件を踏まえると、target は次のように定義できる。

### 1. Product surface

- `/` は `ambient observability surface`
- incident は別ページではなく、同一 surface 上に `workspace` が立ち上がる
- top shell は共通
- left rail は `services -> incidents` に切り替わる
- right rail は incident 時のみ出る

### 2. Incident workspace

first viewport の主構造は次である。

1. What broke
2. One safe action
3. Recovery
4. Cause
5. Evidence entry
6. Chat / uncertainty / competing hypothesis

### 3. Evidence Studio

first viewport の主構造は次である。

1. Proof cards
2. Component relation
3. Raw evidence tabs

### 4. Interaction principle

- `decision first / diagnosis-led + evidence-supported`
- raw telemetry の自己解釈を要求しない
- trust formation は `uncertainty -> concise reason -> evidence -> chat`
- first viewport に重い追加 fetch を置かない

## Current Develop Reality

### Console shell

現状は [AppShell.tsx](/Users/murase/project/3amoncall/apps/console/src/components/shell/AppShell.tsx) を中心に、

- top bar
- left rail
- center board
- right rail

の 3 カラム固定で構成されている。

しかし実態は `always-on incident detail shell` である。

- `/` は [index.tsx](/Users/murase/project/3amoncall/apps/console/src/routes/index.tsx) で open incident に redirect
- normal mode route は存在しない
- left rail は [LeftRail.tsx](/Users/murase/project/3amoncall/apps/console/src/components/shell/LeftRail.tsx) で `Open Incidents` 固定
- right rail は [RightRail.tsx](/Users/murase/project/3amoncall/apps/console/src/components/shell/RightRail.tsx) で常時存在

### Incident board

[IncidentBoard.tsx](/Users/murase/project/3amoncall/apps/console/src/components/board/IncidentBoard.tsx) は

- WhatHappened
- ImmediateAction
- CausalChain
- BottomGrid

の縦積みであり、`board` 構造である。

`Recovery / Cause / Proof / Component relation` は上位構造になっていない。

### Evidence Studio

[EvidenceStudio.tsx](/Users/murase/project/3amoncall/apps/console/src/components/evidence/EvidenceStudio.tsx) は

- modal header
- tab bar
- active raw view

の構造で、主語は `tab-first raw viewer` である。

### Data read path

current console query は [queries.ts](/Users/murase/project/3amoncall/apps/console/src/api/queries.ts) の

- `GET /api/incidents`
- `GET /api/incidents/:id`

だけである。

receiver 側 read API も [api.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/api.ts) の

- incidents list/detail
- packet fetch
- diagnosis callback
- chat

だけであり、`ambient surface` 用の read model は存在しない。

## Fit-Gap

### A. Shell / Navigation

#### Target

- `/` = normal mode
- incident = in-place workspace open
- top shell shared
- left rail data source swap
- right rail conditional

#### Current

- `/` redirect
- incident page always open
- rails always incident-centric

#### Gap assessment

- **Gap level: High**
- **UI-only: No**

#### Why

UI だけではなく route state と shell state が不足している。

現状の router は `incident page` を前提にしているため、

- normal mode の初期状態
- selected incident を URL と同期する方法
- page transition ではなく workspace open として扱う方法

を再定義する必要がある。

#### Practical answer

最も現実的なのは、

- `/` を root surface にする
- `incidentId` を search param で持つ
- `/incidents/:id` は互換 redirect にする

という方針である。

これなら same-origin SPA のまま deep link を保てる。

#### Transition constraint

ここは単なる route design ではなく、**in-place CSS transition を守ること自体が制約** である。

つまり実装は次を前提にする。

- incident open は page replace ではなく shell state change
- right rail は unmount しない
- width `0 -> 220px` と opacity で出す
- center は normal / incident の 2 surface を DOM 上に常駐させる
- 切り替えは `opacity + transform` を主に使い、layout thrash を避ける

これを外すと product definition の

- 平常時画面の上に workspace が立ち上がる
- dramatic だが同一 surface である

が崩れる。

### B. Normal Mode Ambient Surface

#### Target

- dense dashboard ではない
- services の状態感が伝わる
- traces / logs / metrics が editorial に流れる
- incident へ自然に入れる

#### Current

- ambient 用 API がない
- service health summary がない
- recent activity stream の read path がない
- receiver は incident canonical store であり、normal mode materialized view を持っていない

#### Gap assessment

- **Gap level: Very High**
- **UI-only: No**

#### Why

`normal-mode-v1` の中心である

- service summaries
- ambient activity stream
- calm telemetry surface

は current API では出せない。

incident store だけから擬似的に normal mode を作ると、

- open incidents がないと空になる
- service health が incident データ依存になる
- ambient ではなく stale status board になる

ため、product definition に合わない。

#### Practical answer

normal mode には新しい read model が必要である。

最低限必要なのは次である。

- `ServiceSurface[]`
  - service name
  - health state
  - req/s
  - p95
  - small trend
- `RecentActivity[]`
  - ts
  - service
  - route/span name
  - status
  - duration

これは receiver の短期バッファまたは ingest 集計から生成する必要がある。

### C. Action Surface

#### Target

`main-board-v4` の action は

- Policy
- Operate
- Steps
- Do Not

の 4 層になっている。

#### Current

[ImmediateAction.tsx](/Users/murase/project/3amoncall/apps/console/src/components/board/ImmediateAction.tsx) が使える入力は

- `recommendation.immediate_action`
- `recommendation.action_rationale_short`
- `recommendation.do_not`

のみである。

#### Gap assessment

- **Gap level: Medium**
- **UI-only: Partial**

#### What can be done now

- action hero を最上位に上げる
- `action_rationale_short` を policy に寄せる
- `immediate_action` を operate / primary instruction に使う
- `do_not` を safety block に使う

#### What cannot be done cleanly now

- platform-specific command comments
- deterministic `Steps 1/2/3`
- structured operation command

#### Practical answer

Phase 1 では、

- primary action text
- short rationale
- do-not

で command surface を作る。

`Policy / Operate / Steps` の完全な構造化は `diagnosis result v-next` 候補である。

### D. Recovery Surface

#### Target

`main-board-v4` の recovery は

- Look
- Means
- Signal
- current / target / trend / status

まで持っている。

#### Current

[MitigationWatch.tsx](/Users/murase/project/3amoncall/apps/console/src/components/board/MitigationWatch.tsx) が使える入力は

- `watch_items[].label`
- `watch_items[].state`
- `watch_items[].status`

のみである。

#### Gap assessment

- **Gap level: High**
- **UI-only: Partial**

#### What can be done now

- Recovery を上位 block に昇格する
- `label -> Look`
- `state -> Means`
- `status -> coarse state`

として再構成する

#### What cannot be done now

- current numeric value
- target threshold
- trend arrow
- signal name の明示的構造

#### Practical answer

Phase 1 では `Look / Means / Status` の recovery card まで。

`Signal / current / target / trend` は、現行 contract では不足する。

これは `operator_guidance.watch_items` の契約拡張が必要である。

### E. Cause Surface

#### Target

- action から半分独立した cause card
- short reason
- compact causal chain

#### Current

- `summary.root_cause_hypothesis`
- `reasoning.causal_chain`

がある。

#### Gap assessment

- **Gap level: Low**
- **UI-only: Yes**

#### Practical answer

これは view model だけでほぼ実現可能である。

むしろやるべきことは、

- chain ラベルの operator language 化
- compact 化
- repeated text の圧縮

である。

### F. Evidence Entry on Main Workspace

#### Target

- evidence counts
- one clear entry point

#### Current

[EvidencePreview.tsx](/Users/murase/project/3amoncall/apps/console/src/components/board/EvidencePreview.tsx) は

- traces count
- metrics count
- logs count
- open button

を持っている。

#### Gap assessment

- **Gap level: Low**
- **UI-only: Yes**

#### Practical answer

これは今すぐ `Evidence` block として再配置できる。

### G. Evidence Studio Proof-First Header

#### Target

- proof cards
- component relation
- raw evidence tabs

#### Current

raw evidence 自体はあるが、主構造は tab-first である。

#### Gap assessment

- **Gap level: Medium-High**
- **UI-only: Partial**

#### What can be done now

- proof cards を diagnosis-led で生成する
- component flow を causal_chain + scope から合成する
- raw tabs はそのまま残す

#### What is weak

- metrics / logs / platform 主役の richness
- explicit evidence pointers
- family weighting

#### Practical answer

Phase 1 は

- `diagnosis-led + evidence-supported`
- empty family に依存しない
- low-signal case でも degrade

を前提に実装する。

proof-first は可能だが、evidence-led では始めない。

### H. Chat

#### Target

- workspace 内の escape hatch
- visible evidence の意味を掘れる
- small visible first utterance

#### Current

- UI 上は right rail footer chat
- API prompt 上は summary / root cause / action / causal chain のみ

#### Gap assessment

- **Gap level: Medium**
- **UI-only: Partial**

#### What can be done now

- small visible utterance
- quick prompts
- rail hierarchy の修正

#### What cannot be done now

- visible proof card や active evidence view に grounded した対話

#### Practical answer

UI の位置づけ変更を先にやる。

その後に

- selected proof card
- active evidence tab
- visible filters

を chat request context に足す。

契約更新前でも prompt 改善で前進可能。

## What Is Actually UI-Only

次は `UI view model` と component 再編集だけで進められる。

1. Incident workspace の section order 変更
2. Cause card の独立
3. Recovery card の昇格
4. Evidence entry の再配置
5. Right rail の trust order 修正
6. Evidence Studio の proof-first header 追加
7. modal title / labeling / schema exposure 改善

## What Is Not UI-Only

次は UI だけでは成立しない。

1. Normal mode ambient surface
2. Service rail in normal mode
3. Recovery current/target/trend
4. Structured action steps / operate command
5. Evidence pointer が明確な proof cards
6. visible evidence aware chat

## Recommended Implementation Strategy

### Phase 0: Define View Models

まず code に入る前に、UI 専用 view model を明文化する。

候補:

- `IncidentWorkspaceVM`
- `RecoveryVM`
- `CauseVM`
- `EvidenceEntryVM`
- `EvidenceStudioVM`
- `CopilotVM`

重要なのは、これを packet schema ではなく `apps/console` 側に置くことだ。

`NormalSurfaceVM` はここでは定義しない。

理由:

- ambient surface は current API に依存せず定義しきれない
- Phase 3 の read model 設計と一体で決めるべき
- ここで先に作ると空振りしやすい

### Phase 1: Refactor Incident Workspace First

対象:

- [IncidentBoard.tsx](/Users/murase/project/3amoncall/apps/console/src/components/board/IncidentBoard.tsx)
- [ImmediateAction.tsx](/Users/murase/project/3amoncall/apps/console/src/components/board/ImmediateAction.tsx)
- [MitigationWatch.tsx](/Users/murase/project/3amoncall/apps/console/src/components/board/MitigationWatch.tsx)
- [CausalChain.tsx](/Users/murase/project/3amoncall/apps/console/src/components/board/CausalChain.tsx)
- [RightRail.tsx](/Users/murase/project/3amoncall/apps/console/src/components/shell/RightRail.tsx)

やること:

1. incident data から VM を組み立てる adapter を追加
2. board を `What broke -> Action -> Recovery -> Cause -> Evidence` に組み替える
3. right rail を `uncertainty -> competing hypothesis -> confidence -> chat` に並べ替える
4. Evidence Studio に proof-first header を入れる

この段階では、

- normal mode はまだ full 実装しない
- route は一旦 `/incidents/:id` のままでもよい

#### Phase 1 testing note

この refactor では既存の component test がかなり壊れる前提で進めるべきである。

方針:

1. VM adapter の pure tests を先に足す
2. section component は snapshot ではなく meaning-based test に寄せる
3. 旧 `WhatHappened / ImmediateAction / CausalChain / MitigationWatch` 単位のテストは、workspace section 単位へ移行する
4. E2E は first viewport contract を守る最小本数へ一時圧縮してもよい

つまり、Phase 1 は UI 実装と同時に **テストの主語も board から workspace に移す** 必要がある

### Phase 2: Introduce Shared App Surface Shell

対象:

- [AppShell.tsx](/Users/murase/project/3amoncall/apps/console/src/components/shell/AppShell.tsx)
- [index.tsx](/Users/murase/project/3amoncall/apps/console/src/routes/index.tsx)
- [TopBar.tsx](/Users/murase/project/3amoncall/apps/console/src/components/shell/TopBar.tsx)
- [LeftRail.tsx](/Users/murase/project/3amoncall/apps/console/src/components/shell/LeftRail.tsx)

やること:

1. `/` を root surface に戻す
2. `incidentId` search param で workspace open を表現する
3. `/incidents/:id` は compatibility redirect にする
4. top shell を normal / incident の mode aware にする
5. right rail を conditional mount にする

この段階では、normal mode 本文は placeholder でもよいが、
shell と state transition はここで固める。

### Phase 3: Add Ambient Read Model

receiver 側に ambient surface 用の read path を足す。

候補:

- `GET /api/surface`
- もしくは
  - `GET /api/services`
  - `GET /api/activity`

必要データ:

- service health summary
- recent activity list
- minimal trend values

注意:

- heavy dashboard にしない
- first paint は軽く
- no extra slow joins in first viewport

#### Architectural note

これは単なる endpoint 追加ではない。

receiver は現状

- incident canonical store
- packet fetch
- diagnosis callback

を主に持っており、ambient surface 用の live-ish read model を持っていない。

したがって、Phase 3 では少なくとも次のどちらかが必要になる。

1. ingest パイプラインから集計する ambient summary store
2. short-term ring buffer / activity buffer

つまりここは

- API design
- storage concern
- retention / aggregation rule

を伴う新しい read model の設計であり、必要なら ADR 候補である。

### Phase 4: Contract Upgrades Only Where Proven Necessary

ここまでやった後、足りないものだけ schema を拡張する。

優先順:

1. `operator_guidance.watch_items` の構造化
2. `recommendation` の structured action 化
3. proof card 用 evidence pointer
4. metrics / logs / platform event の typed evidence

packet は最後に見直す。

## Proof Card Mapping v1

Phase 1 の `EvidenceStudioVM` では、proof card を evidence family から直接作るのではなく、
**diagnosis result を主、packet evidence を従** として合成する。

最初の mapping は次を推奨する。

### Card 1: Cause / Trigger proof

- primary source:
  - `summary.root_cause_hypothesis`
  - `reasoning.causal_chain[0..1]`
- supporting evidence:
  - `packet.evidence.representativeTraces`
  - `packet.scope.affectedDependencies`
  - `packet.triggerSignals`

### Card 2: Amplifier / Design gap proof

- primary source:
  - `reasoning.causal_chain[1..2]`
  - `recommendation.action_rationale_short`
- supporting evidence:
  - representative trace details
  - relevant logs / platform events when present

### Card 3: Recovery / Impact proof

- primary source:
  - `operator_guidance.watch_items`
  - `summary.what_happened`
- supporting evidence:
  - traces / metrics / logs that match visible impact or recovery checks

### Selection rule

signal family の豊かさに依存せず、次の degrade path を持つ。

1. platform event があれば優先して使う
2. relevant logs があれば補助に使う
3. changed metrics があれば recovery / impact に使う
4. 何もなければ representative traces を使う

重要なのは、proof card を

- `evidence-only`

で作ろうとしないことだ。

Phase 1 の実態はあくまで

- `diagnosis-led + evidence-supported`

である。

## Implementation Lanes

実装は 2 レーンで並行できる。

```
Lane A (console):  Phase 0 → Phase 1 → Phase 2 → Phase 4
Lane B (receiver): Phase 3 ──────────────────────────────┐
                                                          ↓
                                        Phase 2 完了後に console が消費
```

- **Lane A**: console 側の全工程。順次依存があるため並行不可
- **Lane B**: receiver の ambient read model 実装。console とコードベースが分離しているため Lane A と同時進行できる

Lane B の完成物は Lane A の Phase 2 完了後にジョインする。

## Recommended Priority

### P0

- UI view model 定義
- incident workspace 再構成
- Evidence Studio proof-first header
- right rail trust order 修正

### P1

- shell / route の normal-incident 二面化
- ambient surface 用 API / read model（Lane B と並行）
- chat context 改善

### P2

- diagnosis result contract 拡張
- packet evidence typing refinement

## Final Judgment

いま実装に入るべきなのは `incident workspace + view model` である。

逆に、いま無理にやるべきでないのは

- full-fidelity normal mode
- schema 先行の大改修
- evidence-only proof UI

である。

一言で言うと、次の正しい順序は

`mock -> fit-gap -> view model -> incident workspace -> shared shell -> ambient read model -> contract refinement`

であり、receiver の ambient read model は console の Phase 1 と並行して着手できる。
