# main-board-v3 Gap Review

- Date: 2026-03-12
- Target mock: [main-board-v3.html](/Users/murase/project/3amoncall/docs/mock/main-board-v3.html)
- Reference: [product-definition-v0-2026-03-12.md](/Users/murase/project/3amoncall/docs/design/product-definition-v0-2026-03-12.md)
- Goal: `main-board-v3` を product definition に近づけるために、どこをどう変えるべきかを差分として整理する

## Summary

`main-board-v3` は現行 UI の改善案としてはかなり良い。  
特に

- `何が壊れているか -> Immediate Action`
- `方針 / 操作 / 手順` に寄せた action card
- `Uncertainty -> Competing Hypothesis -> Confidence`
- Key Evidence の導入

は明確に前進している。

ただし、product definition が求めているのは `improved board` ではなく、`act-first reliability workspace` である。  
その観点では、まだ **主語が board のまま** であり、workspace に必要な構造差分が残っている。

## What To Keep

以下は残してよい。

1. Top headline の優先順  
`何が壊れているか` を先に出している点は正しい。

2. Unified Action Card の方向  
方針 / 操作 / 手順 / do-not をまとめて扱う発想は正しい。

3. 右レールの順序  
`Uncertainty -> Competing Hypothesis -> Confidence` は product definition と整合する。

4. Evidence Studio に Key Evidence を pin する発想  
proof-first への入口として残す価値がある。

## Core Gaps

### Gap 1: Recovery が上位構造になっていない

Current:
- `Mitigation Watch` が bottom grid の 1 カードとして置かれている

Desired:
- `Recovery` は bottom card ではなく、上位の primary block として独立すべき

Why:
- product definition では、原因理解だけでなく `どうなれば戻ったと判断できるか` が incident workspace の中心にある
- watch item は「あとで見る補足」ではなく、アクション後に最初に見る guide である

Change:
- `Mitigation Watch` を廃止するのではなく、`Recovery card` に昇格させる
- card の構造は
  - Look
  - Means
  - Signal
  の 3 段でよい

### Gap 2: Cause が Action の付属説明に留まっている

Current:
- `Why This Works` の開閉コンテンツとして因果連鎖が入っている

Desired:
- `Cause card` として Action から半分独立させる

Why:
- 現在は Action を理解するための補足説明としてしか cause が存在しない
- product definition では `Cause` は独立した認知対象であり、Recovery と並ぶ上位概念

Change:
- `Why This Works` の因果連鎖は、Action card の中から出して別 card へ分離する
- Action は「何をするか」に集中させ、Cause は「なぜそう見ているか」に集中させる

### Gap 3: Evidence Studio がまだ tab-first

Current:
- Key Evidence bar はあるが、主構造は `Metrics / Traces / Logs / Platform Logs`

Desired:
- 主構造を
  - Recovery
  - Cause
  - Proof
  - Component relation
  - Raw evidence
  に寄せる

Why:
- product definition では telemetry type をユーザーに選ばせるのが主目的ではない
- 見るべき場所は UI 自体が先に絞るべき

Change:
- タブを消す必要はない
- まず Evidence Studio の first viewport を `proof-first summary` に変え、その下でタブへ落とす
- つまり
  - top: proof cards
  - middle: component relation
  - bottom: tabbed raw evidence
  の順にする

### Gap 4: Proof cards がない

Current:
- Key Evidence bar はあるが、横断的に比較できる proof card にはなっていない

Desired:
- 2〜3 枚の proof card を first viewport に持つ

Why:
- product definition は `AI 提案の裏取り workspace` を求めている
- 今の pinned bar は補足であり、主役の証拠面にはなっていない

Change:
- まずは `diagnosis-led + evidence-supported` でよい
- card には最低限
  - label
  - one-line proof
  - source family
  を持たせる

### Gap 5: Component relation がない

Current:
- Causal chain はあるが、component relation としては弱い

Desired:
- `どこが原因で、どこが被害を受けているか` が視覚的に分かる component flow が必要

Why:
- product definition では、component 表示は単なる topology ではなく `因果と被害の地図`

Change:
- 既存 causal chain をそのまま使わず、
  - cause node
  - spread node
  - impact node
  の因果フローへ再設計する

### Gap 6: Chat が右レールの補助機能に留まっている

Current:
- right rail footer の chat

Desired:
- workspace 内で軽く見えている escape hatch

Why:
- product definition では chat は `違和感を処理する第一の逃げ道`
- 今の配置だと「最後に使う補助機能」に見えやすい

Change:
- right rail 依存をやめる必要はない
- ただし visual hierarchy 上は、workspace の一部として見えるようにする
- 初期状態で小さな opener と 1 つの AI utterance を見せる

### Gap 7: normal mode / incident mode の二面性が表現されていない

Current:
- このモックは incident board 単体

Desired:
- ambient normal mode と dramatic incident workspace の関係が見える

Why:
- product definition のアイデンティティはこの二面性にある

Change:
- `main-board-v3` 単体ではなく、次の mock では normal mode との接続を一緒に見せるべき

## Recommended Rewrite Order

優先順位は次の通りがよい。

1. `Mitigation Watch` を `Recovery card` に昇格
2. `Why This Works` を `Cause card` に分離
3. Evidence Studio first viewport を `proof cards + component relation` に変更
4. Chat を workspace 内の escape hatch に再配置
5. 最後に normal mode との接続を設計

## Concrete Rewrite Shape

`main-board-v3` を product definition に寄せるなら、中心構造は次のように変えるのがよい。

1. What broke
2. Action
3. Recovery
4. Cause
5. Proof cards
6. Component relation
7. Raw evidence
8. Chat

この順にすることで、今の `board` から `workspace` に変わる。

## Final Judgment

`main-board-v3` は捨てるべき mock ではない。  
ただし、完成形に近いとも言えない。

一言で言うと、

- **現行 UI の improved board としては良い**
- **product definition が求める workspace としては未完成**

である。

次にやるべきことは、見た目を磨くことではなく、

`Recovery / Cause / Proof / Component relation`

を上位構造として持つ形へ、レイアウトの主語を変えることである。
