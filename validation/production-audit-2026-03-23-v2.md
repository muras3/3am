# Production Audit Report — 2026-03-23 (v2)

**Target:** `https://3amoncall-production.up.railway.app` (Railway staging)
**Reference:** `docs/mock/lens-prototype-v1.html`
**Method:** Mock と Production を Playwright で操作し、スクリーンショットで目視比較。
**Previous audit:** 2026-03-23 v1 (同日、準拠率 ~52%)

---

## プロダクト評価

> **約束: 「午前3時に叩き起こされたエンジニアが、5分以内に原因を特定し、正しい初動を取れるようにする」**

### Console を開く（L0）

**前回からの最大改善: Runtime Dependency Map にデータが表示されている。**

Production の Map は incident-scoped fallback として 4ノード（orders.requ... → payment.ch... → stripe + checkout.re...）を表示。3段構造（ENTRY POINTS / RUNTIME UNITS / DEPENDENCIES）が可視化されている。Stats bar は 15 Active Incidents, 4 Degraded Services, 7 Req/s, 6860ms P95 と実データを表示。

ただし「LIVE WINDOW EMPTY — Showing observed spans captured with captured incident window」の注意書きが表示され、リアルタイムではなく保存済み incident window の span を使っている。Mock のような live traffic 表示ではないが、**topology が一目でわかる** という最低要件は満たしている。

### Incident をクリックする（L1）

構造は前回と大きく変わらないが、**Causal Chain が横一列表示**になっている。EXTERNAL TRIGGER → DESIGN GAP → DESIGN GAP → CASCADE → USER IMPACT が色分けタグ付きで横に並ぶ。これは Mock の設計意図に準拠。

Headline は依然として LLM 出力の長文だが「Full headline」で折りたたみ可能。同様に「Full action details」「Full root cause」「Show all checks (8)」「Confidence details」と、情報量の多いセクションが展開可能になっている。これにより first viewport の情報密度は改善。

IMMEDIATE ACTION は番号付きステップ（1, 2, 3）で構造化されている。

### Evidence を確認する（L2）

Evidence Studio は前回 v1 の改善をそのまま維持。Span 展開 + CORRELATED LOGS、Proof Cards 説明テキスト、Q&A 部分実装、expected vs observed アノテーション。

**Evidence タブ遮蔽バグは依然として再現する。** Playwright の click で `.lens-traces-annotation` が Metrics タブを物理的に遮蔽し、pointer events を intercept する。

### Diagnosis 未完了時

INC-413BDE8A (MEDIUM) の degraded state は改善されている。「Narrative diagnosis not available」の明確なステータス表示、「VISIBLE NOW」と「STILL PREPARING」の2カラム分類、60% Medium confidence、fallback の operator guidance がすべて表示されている。

---

## L0 — System Topology Map

| 要素 | Mock | Production | 準拠 | v1比 |
|------|------|-----------|------|------|
| Stats bar 構造 | 4列 | 4列 | OK | 同 |
| Stats ラベル | "Degraded Services" | "Degraded Services" | OK | 同 |
| Map 3段ノードグラフ | 3 EP / 2 RU / 2 DEP | 2 EP / 1 RU / 1 DEP (incident-scoped) | **△** | **大幅改善** (前回 "No traffic") |
| Map tier ラベル（縦書き） | ENTRY POINTS / RUNTIME UNITS / DEPENDENCIES | ✅ 表示 | OK | **改善** |
| Map ノード differentiation | entry=左border, unit=角丸, dep=破線+EXTERNAL | ✅ 確認可能 | OK | **改善** |
| Map SVG エッジ | 色分け実線/破線 | ✅ 赤実線表示 | OK | **改善** |
| Map 凡例 | 6種 | 6種 | OK | 同 |
| Incident Strip headline | 短い1行 | 長文 truncated | △ | 同 |
| Incident severity badge | CRITICAL / MEDIUM 色分け | CRITICAL / MEDIUM 色分け | OK | 同 |
| Incident click → L1 | ✅ | ✅ | OK | 同 |
| Breadcrumb | Map > Incident > Evidence | Map > Incident > Evidence | OK | 同 |

**L0 準拠率: ~70%** — 前回 (~40%) から **+30pt**。Map データ表示が支配的改善。

---

## L1 — Incident Board

| 要素 | Mock | Production | 準拠 | v1比 |
|------|------|-----------|------|------|
| ヘッダー INC ID | INC-0892 短縮 | INC-070C0148 (8文字) | △ | 同 |
| ヘッダー Duration | "Duration: 8m 14s" | "48h 17m" | OK | 同 |
| Headline | 短い1行 | 長文（折りたたみ可） | △ | △改善 |
| Tag chips | 4つ | 3つ (98%, exception, stripe) | △ | 同 |
| IMMEDIATE ACTION hero | ✅ | ✅ 番号付きステップ | OK | 同 |
| Why 説明 | 1行 | 長文（折りたたみ可） | △ | △改善 |
| Do not | 1行 | ✅ 表示 | OK | 同 |
| Blast Radius 棒グラフ | 複数サービス | 1サービス (98%) | △ | 同 |
| Confidence | 85% + Risk | 85% + Risk + 詳細展開可 | OK | 同 |
| Operator Check | 3項目 | 2+「Show all checks (8)」 | OK | 同 |
| Root Cause Hypothesis | 段落 | ✅ 折りたたみ可 | OK | 同 |
| **Causal Chain レイアウト** | **横一列4段** + 色上線 + 破線コネクタ | **横一列5段** + 色タグ | **OK** | **大幅改善** (前回 縦5段) |
| Causal Chain タイプ色 | amber/teal/accent | ✅ タイプ別色 | OK | 同 |
| Evidence 行 | ✅ | ✅ (visible below fold) | OK | 同 |
| "Open Evidence Studio" | ✅ | ✅ | OK | 同 |
| **First viewport 情報収容** | **✅ スクロール不要** | **△ 折りたたみにより改善** | **△** | **改善** |

**L1 準拠率: ~72%** — 前回 (~60%) から **+12pt**。Causal Chain 横レイアウト + 折りたたみ可能セクション。

---

## L2 — Evidence Studio

| 要素 | Mock | Production | 準拠 | v1比 |
|------|------|-----------|------|------|
| ヘッダー severity badge | ✅ CRITICAL | ✅ CRITICAL | OK | 同 |
| ヘッダー Action 行 | "Action: Enable batching" | ✅ Action 1行表示 | OK | **改善** |
| Proof Cards 構造 | 3枚横並び | 3枚横並び (Trigger/Design Gap/Recovery Path) | OK | 同 |
| Proof Cards 説明テキスト | 各1行 | ✅ 表示 | OK | 同 |
| Proof Cards ステータス | — | CONFIRMED / INFERRED / PENDING | OK | 同 |
| Q&A 入力バー | `?` + input | "What evidence is avail. Ask" | △ | 同 |
| Q&A 回答ブロック | teal背景 | "CURRENT READ" + "STILL PREPARING" | △ | 同 |
| Q&A Follow-up chips | 4つ | 3つ (Open traces / Inspect metrics / Review related logs) | △ | 同 |
| タブ Traces/Metrics/Logs | ✅ | ✅ | OK | 同 |
| **Evidence タブ click** | ✅ | **NG — 遮蔽バグ継続** | **NG** | 同 |
| Trace waterfall | ✅ | ✅ | OK | 同 |
| Trace expected vs observed | ✅ | ✅ "Observed 1672ms vs expected 122ms from 553 baseline" | OK | 同 |
| Span click → 展開 | Attributes + Correlated Logs | ✅ CORRELATED LOGS | △ | 同 |
| Span Attributes テーブル | http.method, status_code 等 | **未実装** | **NG** | 同 |
| Smoking gun ハイライト | 太ボーダー + 背景色 | なし | **NG** | 同 |
| Baseline toggle | "Show expected trace" | なし（数値比較はあり） | **NG** | 同 |
| Metrics タブ | hypothesis-grouped | ✅ (URL パラメータでのみアクセス可) | △ | 同 |
| Logs タブ | claim-clustered | ✅ (URL パラメータでのみアクセス可) | △ | 同 |
| 右サイドバー Confidence | ✅ | ✅ | OK | 同 |
| 右サイドバー Uncertainty | ✅ | ✅ | OK | 同 |

**L2 準拠率: ~58%** — 前回 (~55%) から **+3pt**。Action 行追加。タブ遮蔽バグ継続。

---

## 全体準拠率サマリー

| レベル | 3/22 | 3/23 v1 | 3/23 v2 | 変化 | 主な改善 |
|--------|------|---------|---------|------|---------|
| L0 System Map | ~40% | ~40% | **~70%** | ↑↑↑ | **Map データ表示（incident-scoped fallback）** |
| L1 Incident Board | ~55% | ~60% | **~72%** | ↑↑ | **Causal Chain 横レイアウト、折りたたみセクション** |
| L2 Evidence Studio | ~35% | ~55% | **~58%** | ↑ | Action 行追加 |
| **全体** | **~43%** | **~52%** | **~67%** | **+15pt** | |

---

## v1 → v2 で改善された項目

1. **Runtime Dependency Map データ表示** — L0 の最大改善。"No traffic observed yet" → incident-scoped fallback で 4ノード + エッジが可視化。3段構造、tier ラベル、ノード differentiation すべて確認
2. **Causal Chain 横一列レイアウト** — 縦5段カード → 横5段カラータグ付き。Mock の設計意図に準拠
3. **折りたたみ可能セクション** — Headline, Action details, Root cause, Operator checks, Confidence details が展開可能に。First viewport の情報密度を改善
4. **Evidence Studio Action 行** — L2 ヘッダーに Action 1行が表示

## v1 から未改善の項目

### Critical（操作導線が壊れている）

1. **Evidence タブ遮蔽バグ** — `.lens-traces-annotation` が Metrics/Logs タブを物理的に隠す。Playwright で再現確認済み。URL パラメータ直書き以外でタブ切替不能
2. **Q&A 自由入力なし** — Mock の中心的インタラクション。固定質問のみ

### Important（情報設計の差異）

3. **Span Attributes テーブル** — http.method, status_code, ratelimit headers 等の KV 表示が未実装
4. **Smoking gun ハイライト** — 根本原因 span の視覚的強調
5. **Baseline toggle** — 正常時 trace との切替表示
6. **Headline 長文** — Mock は1行。Production は折りたたみ可能だが初期表示が長い

### Minor

7. **INC ID 形式** — Mock は INC-0892 (4桁)、Production は INC-070C0148 (8文字)
8. **Map がリアルタイムではない** — incident-scoped 保存データの fallback 表示。live traffic ではない

---

## 設計上の注目点

### Degraded state（diagnosis 未完了）

INC-413BDE8A (MEDIUM, 6d ago) の degraded state は良好:
- 「Narrative diagnosis not available」の明確なステータスパネル
- 「VISIBLE NOW」（severity, blast radius, Evidence Studio）と「STILL PREPARING」（immediate action, root cause, confidence）の2カラム分類
- 60% Medium confidence + fallback operator guidance
- Causal Chain は空（表示なし）

前回指摘の「LLM なしでも箱が埋まっている状態」に大きく近づいた。

### IMMEDIATE ACTION の構造化

番号付きステップ（1, 2, 3）で表示。Mock は1段落だが Production は複数ステップに分解。診断エンジンの出力品質は Mock を超えている。

---

## スクリーンショット一覧

| ファイル | 内容 |
|---------|------|
| `audit-2026-03-23-v2-mock/01-L0-map.png` | Mock L0 — Runtime Map + Stats + Incident Strip |
| `audit-2026-03-23-v2-mock/02-L1-incident-board.png` | Mock L1 — Incident Board (first viewport) |
| `audit-2026-03-23-v2-mock/03-L2-evidence-studio.png` | Mock L2 — Evidence Studio |
| `audit-2026-03-23-v2-live/01-L0-map.png` | Production L0 — **Map with incident-scoped nodes** |
| `audit-2026-03-23-v2-live/02-L1-incident-board.png` | Production L1 — Incident Board 上部 |
| `audit-2026-03-23-v2-live/02b-L1-middle.png` | Production L1 — 中部 |
| `audit-2026-03-23-v2-live/02c-L1-bottom.png` | Production L1 — 下部 |
| `audit-2026-03-23-v2-live/02d-L1-very-bottom.png` | Production L1 — 最下部 |
| `audit-2026-03-23-v2-live/03-L2-evidence-studio.png` | Production L2 — Evidence Studio Traces |
| `audit-2026-03-23-v2-live/03c-L2-metrics.png` | Production L2 — Metrics (URL param) |
| `audit-2026-03-23-v2-live/03d-L2-logs.png` | Production L2 — Logs (URL param) |
| `audit-2026-03-23-v2-live/04-L1-no-diagnosis.png` | Production L1 — diagnosis 未完了 |
