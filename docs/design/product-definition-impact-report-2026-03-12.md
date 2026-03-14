# Product Definition Impact Report

- Date: 2026-03-12
- Basis:
  - [product-definition-v0-2026-03-12.md](/Users/murase/project/3amoncall/docs/design/product-definition-v0-2026-03-12.md)
  - ADR set in [docs/adr](/Users/murase/project/3amoncall/docs/adr)
  - Current console / schema / API implementation in `develop`-aligned code
- Goal: product definition を可能な限り実現する前提で、ADR / 設計 / 実装への影響、優先度、実現性を冷静に整理する

## Executive Summary

結論から言うと、新しい product definition は **現行アーキテクチャと完全には衝突しない**。  
ただし、現行実装は `incident-console-v3` を基準に作られているため、**UI の再編集だけでは足りず、少なくとも view model の再設計は必要** である。

一方で、最初から `packet` や `diagnosis result` の contract を壊しに行く必要はない。  
Phase 1 としては、次の順が最も妥当である。

1. **UI view model で吸収できる範囲を先に広げる**
2. そのうえで、本当に不足する情報だけを `diagnosis result` に戻す
3. `packet` は最後に見直す

つまり、今回の product definition は

- **短期**: view model と UI 再構成でかなり前進できる
- **中期**: diagnosis result の contract 拡張が必要になる
- **長期**: packet evidence / retrieval の refinement が必要になる

というのが冷静な見立てである。

## Product Definition が要求する変化

新しい product definition が要求しているのは、単なる visual polish ではない。

主な変化は以下である。

1. `MTTR 最小化` を主目的にした act-first UI への転換
2. `何が壊れているか -> 1つの推奨アクション -> recovery / cause -> evidence`
   という階層への再編
3. Evidence Studio を `raw data viewer` から `AI 提案の裏取り workspace` へ再定義
4. 平常時の `ambient observability surface` と incident 時の `workspace` という二面性の追加
5. chat を補助要素から `違和感を処理する第一の逃げ道` へ昇格

このうち、1-3 は現在の incident detail を再編集する話であり、4 は product surface の追加、5 は chat contract と prompt scope への影響がある。

## ADR Impact

### ADR 0018: Incident Packet Semantic Sections

- Impact: `中`
- Assessment:
  - product definition 自体は ADR 0018 と整合する
  - ADR 0018 は packet を canonical incident model とし、UI 固有の構造を packet に持たせない方針である
  - 新しい UI でもこの方針は維持すべき
- Practical implication:
  - `recovery card`
  - `cause card`
  - `proof cards`
  - `component relation`
  は packet そのものではなく、**packet + diagnosis result から合成する UI view model** に置くのが正しい
- Risk:
  - UI 都合で packet に `ui card names` や `display order` を入れると ADR 違反になる
- Recommendation:
  - ADR 更新は不要
  - まず UI 側 view model を追加する

### ADR 0019: Diagnosis Result Minimum Contract

- Impact: `高`
- Assessment:
  - 現在の contract は `summary / recommendation / reasoning / operator_guidance / confidence` に整理されており、今の product definition の方向と大枠では合っている
  - ただし、新しい定義では `recovery-first` と `act-first` が強まり、現行 contract では粒度が不足する
- Current gaps:
  - `recommendation.immediate_action` が 1 本の文字列で、`方針 / 操作 / 手順` に分かれていない
  - `operator_guidance.watch_items` は `label / state / status` のみで、recovery guide としては弱い
  - `confidence.uncertainty` は 1 文字列で、`どういう条件なら疑うべきか` の構造化がない
  - `reasoning.causal_chain` はあるが、component relation と proof emphasis を直接支えるには不足する
- Recommendation:
  - 最初は UI 側で分解・再編成する
  - それで不足する場合、`diagnosis result v-next` を ADR 0019 追補として検討する

### ADR 0025: Performance and Responsiveness Guardrails

- Impact: `高`
- Assessment:
  - 新しい product definition は dramatic な workspace を求めるが、ADR 0025 は first viewport と response speed を最優先にしている
  - これは衝突ではなく制約
- Practical implication:
  - 平常時 ambient surface は heavy dashboard にしてはいけない
  - incident workspace も初回表示は `current detail + cached packet + diagnosis` の範囲で完結すべき
  - proof cards や filtered evidence は lazy / secondary loading の設計が必要
- Recommendation:
  - UI 案を作る際、最初から `no heavy extra fetch in first viewport` を前提にする

### ADR 0027: AI Copilot Chat Contract

- Impact: `中-高`
- Assessment:
  - ADR 0027 は現存する。参照先は [0027-ai-copilot-chat-contract.md](/Users/murase/project/3amoncall/docs/adr/0027-ai-copilot-chat-contract.md)
  - 現在の chat contract は `summary / root cause / action / causal chain` の要約だけを prompt に入れており、意図的に raw evidence を入れていない
  - 新しい product definition では chat は `visible evidence の意味を深掘る役` になるため、現行 prompt では力不足の可能性が高い
- Current gaps:
  - watch item の意味説明はできても、evidence family ごとの差や proof emphasis の説明は弱い
  - user が「これってどういう意味？」と聞いた時に、画面と同じ視点を共有しにくい
- Recommendation:
  - chat の role 自体は ADR 0027 の範囲内で拡張可能
  - ただし system prompt と request context は見直しが必要
  - まずは prompt improvement で対応し、contract 更新は後回しでよい

### ADR 0028: Receiver Serves Console

- Impact: `低`
- Assessment:
  - UI が normal mode / incident mode の二面性を持っても、same-origin BFF 方針はそのまま使える
- Recommendation:
  - ADR 更新不要

### ADR 0022 / 0023: Ingest と Instrumentation Minimum

- Impact: `高`
- Assessment:
  - 新しい UI は `何を見ればよいかが明確` な evidence workspace を求める
  - そのためには metrics / logs / platform events の品質が現在以上に重要になる
- Practical implication:
  - 現行の signal quality が弱いと、UI だけ再設計しても proof card が薄くなる
  - 特に `changedMetrics`, `relevantLogs`, `platformEvents` が sparse あるいは low-signal なら、`proof-first` な Evidence Studio は成立しない
  - これは単なる quality concern ではなく、**P1 の UI 再設計を空振りさせる blocking risk** になりうる
- Recommendation:
  - UI 着手前、または少なくとも並行で、validation run を使って signal quality を実測確認すべき
  - `proof card を成立させる最低限のデータが現状で取れているか` を最初に確認する

## Current Code Impact

### Console shell

Relevant files:
- [AppShell.tsx](/Users/murase/project/3amoncall/apps/console/src/components/shell/AppShell.tsx)
- [LeftRail.tsx](/Users/murase/project/3amoncall/apps/console/src/components/shell/LeftRail.tsx)
- [RightRail.tsx](/Users/murase/project/3amoncall/apps/console/src/components/shell/RightRail.tsx)

Assessment:
- 現在の shell は `incident detail always-on` の構造
- 平常時 ambient surface という product definition には未対応
- RightRail は静的 summary / uncertainty / operator check を出す設計で、`small visible chat panel` という新しい役割にはまだ合っていない

Impact level:
- `高`

Recommendation:
- 新しい `normal mode route/shell`
- incident 時の `workspace shell`
の再定義が必要

### Incident board

Relevant files:
- [IncidentBoard.tsx](/Users/murase/project/3amoncall/apps/console/src/components/board/IncidentBoard.tsx)
- [WhatHappened.tsx](/Users/murase/project/3amoncall/apps/console/src/components/board/WhatHappened.tsx)
- [ImmediateAction.tsx](/Users/murase/project/3amoncall/apps/console/src/components/board/ImmediateAction.tsx)
- [CausalChain.tsx](/Users/murase/project/3amoncall/apps/console/src/components/board/CausalChain.tsx)
- [BottomGrid.tsx](/Users/murase/project/3amoncall/apps/console/src/components/board/BottomGrid.tsx)

Assessment:
- 現在は `what happened -> immediate action -> why this action -> bottom grid`
  という v3 前提の縦積み
- 新しい product definition が求める
  - `recovery-first`
  - `cause / proof / component relation`
  - `one action as command surface`
 とはズレる

Impact level:
- `高`

Recommendation:
- ここは UI 再編集の中心
- ただし、今ある
  - recommendation
  - causal chain
  - mitigation watch
 という素材は流用可能

### Evidence Studio

Relevant files:
- [EvidenceStudio.tsx](/Users/murase/project/3amoncall/apps/console/src/components/evidence/EvidenceStudio.tsx)
- [EvidencePreview.tsx](/Users/murase/project/3amoncall/apps/console/src/components/board/EvidencePreview.tsx)

Assessment:
- 現在は `tab-first` で `traces / metrics / logs / platform logs` を並べる構造
- これは product definition の `proof-first` / `decision-first` とは最もズレが大きい
- 一方で、Evidence Studio という概念自体は正しい
- さらに、`proof card` を成立させるには「どの evidence がどの仮説や recovery guide を支えるか」が必要だが、現行データ契約ではその結び付きが弱い

Impact level:
- `非常に高い`

Recommendation:
- 最優先の再設計対象
- `proof cards -> component relation -> filtered raw evidence`
  の段階構造へ移すべき
- ただし low-fi 設計と並行して、`proof card の根拠データが現行 contract で本当に引けるか` を検証する必要がある

### Chat

Relevant files:
- [RightRail.tsx](/Users/murase/project/3amoncall/apps/console/src/components/shell/RightRail.tsx)
- [api.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/api.ts)

Assessment:
- 現在の chat は right rail footer の input ベースで、incident workspace の主役ではない
- system prompt も summary 寄りで、evidence meaning の深掘りには不足

Impact level:
- `中`

Recommendation:
- UI 上の位置づけの変更が先
- その後 prompt / context の改善

### Core schemas

Relevant files:
- [incident-packet.ts](/Users/murase/project/3amoncall/packages/core/src/schemas/incident-packet.ts)
- [diagnosis-result.ts](/Users/murase/project/3amoncall/packages/core/src/schemas/diagnosis-result.ts)

Assessment:
- `IncidentPacketSchema` は canonical model として概ね正しい
- ただし `changedMetrics`, `relevantLogs`, `platformEvents` がまだ `unknown[]` で、proof-first UI を強く支えるには弱い
- `DiagnosisResultSchema` は最小 contract としては成立しているが、new product definition の UI を直接支えるには粗い
- 特に、`どの evidence が因果チェインのどの部分を支えているか` を UI が明確に見せたい場合、現行 `DiagnosisResultSchema` だけでは evidence pointer が不足する

Impact level:
- packet: `中`
- diagnosis result: `高`

Recommendation:
- まず view model で吸収
- そのうえで、proof card の成立に必要な evidence pointer が view model で合成できない場合は、`diagnosis result` 側の contract 拡張を P1/P2 境界で再評価する

## Priority / Feasibility Matrix

### P1: すぐ着手してよい

1. **Signal quality の現状確認**
- Why:
  - proof-first UI の成立条件を先に確認しないと、UI 再設計が空振りする
- Feasibility:
  - `高`
- ADR impact:
  - `なし`

2. **UI view model の導入**
- Why:
  - ADR 0018 を守りながら UI を再編集できる
- Feasibility:
  - `高`
- ADR impact:
  - `なし`

3. **IncidentBoard の情報階層再編集**
- Why:
  - product definition と現行 UI のズレが最も大きい
- Feasibility:
  - `中-高`
- ADR impact:
  - `なし`

4. **Evidence Studio の tab-first 脱却**
- Why:
  - 今回の product definition の核心
- Feasibility:
  - `中`
- ADR impact:
  - `なし`

### P2: 方向が固まったらやる

5. **chat prompt の見直し**
- Why:
  - chat を `meaning interpreter` に寄せるため
- Feasibility:
  - `中`
- ADR impact:
  - `ADR 0027 の軽微見直しの可能性`

6. **DiagnosisResult contract の拡張検討**
- Why:
  - `方針 / 操作 / 手順`
  - recovery guide
  - uncertainty conditions
  - evidence pointer
 などが今より構造化されると UI に効く
- Feasibility:
  - `中`
- ADR impact:
  - `ADR 0019 追補が必要`

### P3: 本格 productization の段階

7. **Packet evidence typing の強化**
- Why:
  - proof-first workspace を強く支えるため
- Feasibility:
  - `中`
- ADR impact:
  - `ADR 0018 の枠内`

8. **normal mode ambient surface の追加**
- Why:
  - product definition の二面性を実現するため
- Feasibility:
  - `中-低`
- ADR impact:
  - `UI / route / shell 設計への影響大`
- Note:
  - product definition 上は重要度が高い
  - ただし Phase 1 の現実的な実装順としては incident workspace を先に成立させる方が defensible
  - ここは「重要度が低い」のではなく、「依存関係上、後段になりやすい」と明示しておくべき

## Recommended Next Step

現時点で最も現実的で、かつ product definition に近づける順番は以下である。

1. **validation run を使って signal quality を先に確認する**
2. **report を基準に、UI view model でどこまで吸えるかを設計する**
3. **IncidentBoard と EvidenceStudio の low-fi 再構成案を作る**
4. **その案を現行 codebase にどう差し込むかを見積もる**
5. **proof card に必要な evidence pointer が足りない場合、diagnosis result 拡張候補を切り出す**
6. **packet は最後に見直す**

## Final Judgment

新しい product definition は、現行の 3amoncall に対して **実現不可能な理想論ではない**。  
ただし、`UI を少し整える` レベルでは届かない。

冷静に言うと、これは

- **短期**: UI 再編集
- **中期**: diagnosis result 再設計
- **長期**: packet evidence refinement

の 3 段階で進めるのが妥当である。

したがって、優先度と実現性の観点では

- **最優先**: signal quality の現状確認
- **次に着手**: IncidentBoard / EvidenceStudio の再構成
- **次点**: chat と diagnosis result の関係見直し
- **後回し**: packet 自体の変更

という順番が最も defensible である。
