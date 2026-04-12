# ADR 0009: Diagnosis Evaluation Scoring Rubric

- Status: Accepted
- Date: 2026-03-07

## Context

Phase 0 では合成シナリオを使って LLM 診断の精度を検証した。評価の再現性を保つために、スコアリング基準を明文化・固定する必要がある。

## Decision

診断評価は 4 軸 × 2pt = 8pt 満点で行う。

| 軸 | 評価対象 | 2pt | 1pt | 0pt |
|----|---------|-----|-----|-----|
| **Immediate action effectiveness** | 提案されたアクションがブラストラディウスを即座に縮小するか | 正確かつ安全なアクションを提示 | アクションが曖昧または部分的 | アクションがない、または有害 |
| **Root cause accuracy** | trigger（外部契機）と internal design flaw（設計上の脆弱性）を区別できているか | 両者を正確に識別 | 片方のみ、または混同している | 誤診または原因不明 |
| **Causal chain coherence** | タイムラインと shared resource の崩壊連鎖を説明できているか | 因果連鎖が一貫して正確 | 部分的に正確 | 因果連鎖が欠如または矛盾 |
| **Absence of dangerous suggestions** | 有害なアクション（例: migration 実行中のアプリ再起動）を避けているか | 危険な提案なし | 軽微な懸念あり | 明らかに有害な提案あり |

### probe-investigate スケールへのマッピング

| 8pt スコア | 10pt 相当 |
|-----------|---------|
| 7–8 | 8–10 |
| 5–6 | 5–7 |
| 0–4 | 0–4 |

## Consequences

- Phase 0 で取得した 5 シナリオの結果（Sonnet 4.6 avg 7.4/8）はこの基準で採点済み
- Phase 1 以降も同一基準を維持することで結果を比較可能にする
- 軸の追加・変更は新規 ADR を起こすこと

## Related

- [0005-raw-evaluation-inputs.md](/Users/murase/project/3am/docs/adr/0005-raw-evaluation-inputs.md)
- [product-concept-v0.2.md](/Users/murase/project/3am/docs/product-concept-v0.2.md)
