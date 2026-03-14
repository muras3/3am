# Proof-First UI Feasibility Check

- Date: 2026-03-12
- Purpose: `proof-first` な Evidence Studio / incident workspace が、現在の validation / fixture / schema でどこまで成立するかを確認する
- Inputs reviewed:
  - [validation-mvp-v0.1.md](/Users/murase/project/3amoncall/docs/validation-mvp-v0.1.md)
  - [local-validation-stack-v0.1.md](/Users/murase/project/3amoncall/docs/local-validation-stack-v0.1.md)
  - [validation/tools/scenario-runner/run.js](/Users/murase/project/3amoncall/validation/tools/scenario-runner/run.js)
  - scenario fixtures under [apps/receiver/src/__tests__/fixtures/scenarios](/Users/murase/project/3amoncall/apps/receiver/src/__tests__/fixtures/scenarios)
  - current packet / diagnosis schemas in [incident-packet.ts](/Users/murase/project/3amoncall/packages/core/src/schemas/incident-packet.ts) and [diagnosis-result.ts](/Users/murase/project/3amoncall/packages/core/src/schemas/diagnosis-result.ts)

## What Was Actually Evaluated

今回確認したのは「OTel の品質が良いか悪いか」ではない。  
確認したのは、**現在の packet + diagnosis から、proof-first UI に必要な情報を scenario ごとに安定して組み立てられるか** である。

最低限、以下が作れるかを見た。

- What broke
- Action
- Recovery
- Cause
- Proof cards 2-3 枚

## High-Level Conclusion

結論は次の通り。

1. **Action / Recovery / Cause は全 5 シナリオで成立する**
2. **Proof cards も全 5 シナリオで最低限は作れる**
3. ただし、その多くは **diagnosis text + representativeTraces に強く依存する**
4. 現時点では **metrics / logs / platform events を主役にした豊かな proof-first UI はまだ弱い**

したがって、

- `proof-first UI は不可能ではない`
- しかし `データ種別を横断して自然に強弱を付ける UI` までは、まだ材料が十分とは言いづらい

というのが冷静な見立てである。

## Important Distinction

validation 基盤は **診断品質を検証する基盤としては十分に進んでいる**。  
ただし、それはそのまま **proof-first UI の成立保証** を意味しない。

理由:

- validation は `正しい診断ができるか` を主に見ている
- proof-first UI は `どの evidence が何の根拠かを視覚的に主従付きで見せられるか` を必要とする

この 2 つは近いが、同一ではない。

## Scenario-by-Scenario Check

### 01. Rate Limit Cascade

- Feasibility: `高`
- What broke: 作れる
- Action: 作れる
- Recovery: 作れる
- Cause: 作れる
- Proof cards: `高`

Why:
- diagnosis が非常に明確
- causal chain も強い
- traces に `504` と `429` があり、cause / impact を視覚的に分けやすい
- watch_items も recovery guide として成立している

Weakness:
- fixture packet の `changedMetrics`, `relevantLogs`, `platformEvents` は空
- 本来このシナリオの主役は metrics だが、fixture 上は traces と diagnosis text が中心になっている

Assessment:
- **proof-first UI は成立する**
- ただし `metrics-first` な rich proof surface は、現行 fixture だけでは弱い

### 02. Cascading Timeout Downstream Dependency

- Feasibility: `高`
- What broke: 作れる
- Action: 作れる
- Recovery: 作れる
- Cause: 作れる
- Proof cards: `高`

Why:
- shared worker pool starvation という構造が diagnosis に明確に出ている
- traces も `/checkout` に child span がないという reasoning を支えている
- watch_items が行動後の確認として分かりやすい

Weakness:
- cause proof は作れるが、依然として traces + diagnosis テキストに偏る
- logs / metrics の cross-family richness は fixture 上では薄い

Assessment:
- **proof-first UI は成立する**
- component relation card も比較的作りやすい

### 03. DB Migration Lock Contention

- Feasibility: `高`
- What broke: 作れる
- Action: 作れる
- Recovery: 作れる
- Cause: 作れる
- Proof cards: `高`

Why:
- lock contention -> migration queue -> pool exhaustion という chain が非常に UI 向き
- red herring (`db_connection_count`) が明示されており、proof / anti-proof card を作りやすい
- operator_checks も行動可能

Weakness:
- packet evidence 自体は still sparse
- DB 観点の platform / log evidence が packet に載っていない

Assessment:
- **proof-first UI のシナリオとして最も強い部類**
- ただし実データより diagnosis に意味づけを借りている

### 04. Secrets Rotation Partial Propagation

- Feasibility: `中-高`
- What broke: 作れる
- Action: 作れる
- Recovery: 作れる
- Cause: 作れる
- Proof cards: `中-高`

Why:
- partial failure / deployment skew という story は強い
- old deployment 401 vs new deployment 200 の contrast は proof card 向き

Weakness:
- proof card の肝は deployment-aware evidence だが、packet 上はその relation が強く構造化されていない
- platform event の明示がないため、UI では diagnosis の文章に依存しやすい

Assessment:
- **成立はする**
- ただし deployment skew を proof-first に見せるには、evidence pointer が今より欲しい

### 05. CDN Stale Cache Poison

- Feasibility: `高`
- What broke: 作れる
- Action: 作れる
- Recovery: 作れる
- Cause: 作れる
- Proof cards: `高`

Why:
- CDN 50ms 503 vs origin 800ms 200 という contrast が非常に視覚的
- cause / impact / recovery の説明も簡潔で強い

Weakness:
- logs / platform events が空
- CDN purge success を支える runtime-side evidence は packet に薄い

Assessment:
- **proof-first UI に非常に向く**
- traces 中心で成立する rare case

## Cross-Scenario Finding

全体として最も大きい事実はこれである。

### 1. Proof card は作れる

全 5 シナリオとも、少なくとも

- Cause proof
- Recovery proof
- Impact proof

に相当するカードは構成できる。

### 2. ただし現在の主材料は diagnosis result である

proof card の説得力は

- diagnosis.summary
- diagnosis.reasoning
- diagnosis.operator_guidance
- representativeTraces

に大きく依存している。

つまり今の実態は、

`evidence-led proof UI`

というより

`diagnosis-led proof UI with evidence support`

に近い。

### 3. Rich な cross-family proof UI はまだ弱い

scenario fixture の多くで

- `changedMetrics = []`
- `relevantLogs = []`
- `platformEvents = []`

であり、現行 packet の canonical examples は trace-heavy である。

これは「validation が弱い」という意味ではない。  
validation の主目的が UI ではなく diagnosis quality だからである。

ただし UI 的には、

- この incident では metrics が主
- この incident では logs が主
- この incident では platform event が鍵

という **signal-family の重み付け** を、fixture から自然に学びにくい。

## What This Means For Design

### Safe conclusion

今すぐ言えること:

- `proof-first UI` は進めてよい
- `IncidentBoard / EvidenceStudio` の low-fi 再設計に進んでよい

### But do not assume

今まだ仮定してはいけないこと:

- metrics / logs / platform events が常に十分に揃う
- proof card を packet evidence だけで安定生成できる
- diagnosis result の evidence pointer なしで完全に説明責任を果たせる

## Recommended Design Constraint

次の UI 設計では、以下を制約として持つのが妥当である。

1. proof card は `diagnosis-led + evidence-supported` で始める
2. signal family の強弱は出すが、空の family に依存しない
3. data-poor case でも成立する degrade path を最初から設計する

つまり、最初の version で作るべきなのは

- `evidence-only proof UI`

ではなく

- `diagnosis の主張を evidence で裏づける proof UI`

である。

## Final Answer

validation を読み込んだ上でも、結論は次のように修正される。

- validation は十分やっている
- ただし、それは diagnosis quality に対して十分という意味
- proof-first UI に対しては、**成立性はあるが、richness はまだ uneven**

したがって、今やるべき確認は「データ品質が悪いのでは？」ではなく、

`proof-first UI を、diagnosis-led + evidence-supported でどこまで作るか`

を前提に設計することである。
