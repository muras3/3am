# UI/UX Review — 2026-03-12

- Target: Console + Evidence Studio
- Reviewed screens: 8 screenshots (validation/reports/)
- Reviewer: Claude (frontend-design skill + vercel-design-guidelines skill)
- Scope: Visual design, information architecture, usability, guideline compliance

---

## P0 — 根本的に壊れている

### 1. Metrics タブ = 生データのダンプ

`validation/reports/03-evidence-metrics.png`

metric名と数値のテキスト行が延々と並ぶだけ。チャートが一切ない。`checkout_requests_total ... 129.0000` を目で追っても何も分からない。診断を助ける情報ではなく、生スキーマの垂れ流し。

- Vercel guideline違反: *"Don't ship the schema"* / *"Design for all states"*

### 2. "TimePlaneDetailsRole" がUIに露出

`validation/reports/05-evidence-platform-logs.png`

内部フィールド名がそのままラベルとして表示されている。

- Vercel guideline直接違反: **"Don't ship the schema"**

### 3. 因果連鎖カードのテキストが読めない

`validation/reports/01-console-main.png` 下部

EXTERNAL → SYSTEM → INCIDENT → IMPACT の5列カード。各カードの説明文が10-11px程度で、通常の閲覧距離では判読不能。インシデント対応中に読める設計ではない。

---

## P1 — 重大な UX 劣化

### 4. Right Rail が壁のテキスト

Confidence Assessment / Uncertainty / Operator Check が同じフォントサイズ・同じウェイトで連続。視線の止まるポイントがない。85% という信頼度の数字が埋没している。

### 5. "What happened" サマリーが非スキャン

`validation/reports/staging-console-full-2026-03-10.png` 上部

インシデント概要が2行の長文ブロック。ストレス下のオペレーターが5秒で把握できない。キーファクト（例: 212 span errors / HTTP 429 / −96 req/2s）はチップや強調表示で抽出すべき。

### 6. Traces ウォーターフォールに色分けがない

`validation/reports/02-evidence-traces.png`

全スパンバーが同一カラー（単色）。error=赤 / slow=アンバー / normal=緑 の色分けがなく、視覚的にトリアージできない。APMとして最低限の表現が欠けている。

### 7. 空状態にガイダンスがない

`validation/reports/04-evidence-logs.png`, `validation/reports/05-evidence-platform-logs.png`

> "No log record data available for this incident."

アイコンなし、理由説明なし、次のアクションなし。

- Vercel guideline違反: **"Provide next steps or recovery paths on every screen"**

### 8. Evidence Studio モーダルが窮屈

タブコンテンツ領域が狭すぎてメトリクス行が縦に大量スクロール。モーダルの高さ・幅が固定されており、データ量に対して器が小さい。

---

## P2 — ポリッシュ・設計品質

### 9. Traces テーブルの情報量が薄い

`validation/reports/02-evidence-traces.png` 下部

| SPAN ID | SERVICE | DETAILS |
|---------|---------|---------|
| `4df7c1a6c84d...` | validation-web | status 0 |

- Span IDが切り詰められていて意味をなさない
- `status 0` は人間が読む情報ではない（スキーマ露出）
- duration, HTTP method, エラー有無など有用な列が欠如

### 10. Left Rail に視覚的シグナルがない

`validation-web OPEN` のバッジのみ。発生からの経過時間、重要度の視覚的グラデーション、複数インシデント時のソート根拠が見えない。

### 11. ヘッダーバーが支配的すぎる

`inc_e15e747d-9ee7... | validation-web | CRITICAL | 05:24:15 UTC | Active`

このメタデータはコンテキスト情報として必要だが、フルウィズスで最上位の視覚重量を持っており、アクション領域を圧迫している。

### 12. Monospace フォントが不統一

メトリクス値・Span ID・タイムスタンプが `--mono: JetBrains Mono` で描画されていない箇所がある。設計トークンの適用が不徹底。`font-variant-numeric: tabular-nums` も未適用の可能性がある。

### 13. Mitigation Watch が読めない幅

下部左カラム。メトリクス名が途中で切れており（`checkout_re[...]`）、ALERTラベルが窮屈。

---

## 問題の優先マトリクス

| 優先度 | 問題 | 影響範囲 |
|--------|------|---------|
| P0 | Metrics = 生データダンプ | Evidence Studio 全体の価値破壊 |
| P0 | TimePlaneDetailsRole 露出 | 信頼性・スキーマ漏洩 |
| P0 | 因果連鎖テキスト判読不能 | メイン画面の核心 |
| P1 | Right Rail 壁テキスト | 診断結果の伝達力 |
| P1 | What happened 非スキャン | 最初の30秒の印象 |
| P1 | Traces 色分けなし | Evidence Studio の診断力 |
| P1 | 空状態ガイダンスなし | 信頼感・次アクションの欠如 |
| P1 | Evidence Studio モーダル窮屈 | Evidence Studio 全体 |
| P2 | Traces テーブル情報薄 | Evidence Studio |
| P2 | Left Rail シグナル不足 | インシデント一覧の判断補助 |
| P2 | ヘッダー過支配 | 全体レイアウト |
| P2 | mono フォント不統一 | 全体的な仕上がり |
| P2 | Mitigation Watch 切れ | 下部3カラム |

---

## レビュー根拠

- **frontend-design skill**: 情報階層・視覚的スキャナビリティ・色分け・密度設計の観点
- **vercel-design-guidelines skill**: "Don't ship the schema" / "Provide next steps on every screen" / `font-variant-numeric: tabular-nums` / empty state design などガイドライン照合
