# Production Audit Report — 2026-03-23

**Target:** `https://3amoncall-production.up.railway.app` (Railway staging)
**Reference:** `docs/mock/lens-prototype-v1.html`
**Method:** Mock と Production を browser-use で実際に操作し、スクリーンショットで目視比較。
**Previous audit:** 2026-03-22 (Vercel `feat/p0-p1-fixes-and-model-env` branch, 準拠率 ~43%)

---

## プロダクト評価

> **約束: 「午前3時に叩き起こされたエンジニアが、5分以内に原因を特定し、正しい初動を取れるようにする」**

### Console を開く（L0）

Mock は Runtime Dependency Map でどのサービスが壊れているか一目でわかる。3 Entry Points → 2 Runtime Units → 2 Dependencies の構造で、赤ノード（Stripe API 429）が視線を引く。

Production は「No traffic observed yet.」空の Map。15件の incident list は見えるが、truncated な長文 headline が並ぶだけで「今どれを見るべきか」が直感的にわからない。Map が本来出すべき「全体像の即時把握」は成立していない。

### Incident をクリックする（L1）

Mock は **全情報が first viewport に収まる**。Headline 1行 → IMMEDIATE ACTION hero → 3カラム（Blast Radius / Confidence / Operator Check）→ Root Cause → Causal Chain 横4段 → Evidence → Open Evidence Studio。スクロールなし。

Production は **1.3 ページ分スクロールが必要**。Headline が LLM 出力の長文そのまま。Causal Chain は横4段ではなく縦5段カード。Root Cause と Evidence は below the fold。3am にスクロールして因果関係に辿り着く体験は、Mock の設計意図（「5秒で理解」）に反する。

ただし、**内容の質は高い**。Immediate Action の具体性、Do not の警告、Operator Check 8項目 — 診断エンジンの出力は Mock のサンプルデータより遥かに実用的。

### Evidence を確認する（L2）

**3/22 からの最大の改善: span クリック展開が動作する。** checkout.request をクリックすると CORRELATED LOGS（±2s のログ3行）が表示される。前回は「何も起きない」だった。

残る差異:
- **Q&A Frame**: Mock は質問入力バー + 回答ブロック + follow-up chips 4つ。Production は固定質問 + deterministic answer のみ。自由質問の入力バーなし
- **Span Attributes テーブル**: Mock は http.method, status_code, ratelimit headers 等の KV 表示。Production は CORRELATED LOGS のみで attributes テーブルなし
- **Smoking gun ハイライト**: Mock は根本原因 span に太ボーダー + 背景色。Production にはなし
- **Baseline toggle**: Mock は「Show expected trace (200, 245ms)」で正常時 trace を切替表示。Production にはこのトグルなし（ただし expected vs observed の数値比較は trace group ヘッダーに表示）
- **Proof Cards 説明テキスト**: Mock は各カードに1行の要約。Production は名前 + ステータスのみ → **改善: 3/23 では説明テキストが表示されている**

---

## L0 — System Topology Map

| 要素 | Mock | Production | 準拠 | 3/22比 |
|------|------|-----------|------|--------|
| Stats bar 構造 | 4列 | 4列 | OK | 同 |
| Stats "Degraded Services" ラベル | "Degraded Services" | "Degraded Services" | OK | **改善** (前回 "Degraded Nodes") |
| Map 3段ノードグラフ | 3 EP / 2 RU / 2 DEP | "No traffic observed yet." | **NG** | 同 |
| Map tier ラベル（縦書き） | ENTRY POINTS / RUNTIME UNITS / DEPENDENCIES | 表示あり（ノードなし） | △ | 同 |
| Map ノード differentiation | entry=左border, unit=角丸, dep=破線+EXTERNAL | 表示不可 | **未検証** | 同 |
| Map SVG エッジ | 色分け実線/破線 | 表示不可 | **未検証** | 同 |
| Map 凡例 | 6種 | 表示あり | OK | 同 |
| Incident Strip ID形式 | INC-0892 (4桁) | INC-070C0148 (8文字) | △ | 同 |
| Incident Strip headline | diagnosis headline | diagnosis headline（長文 truncated） | △ | 同 |
| Incident severity badge | CRITICAL / MEDIUM 色分け | CRITICAL / HIGH / MEDIUM 色分け | OK | 同 |
| Incident click → L1 | ✅ | ✅ | OK | 同 |
| Breadcrumb | Map > Incident > Evidence | Map > Incident > Evidence | OK | 同 |

**L0 準拠率: ~40%** — 前回と同様。Map のデータ依存消失が支配的。

---

## L1 — Incident Board

| 要素 | Mock | Production (diagnosed) | 準拠 | 3/22比 |
|------|------|----------------------|------|--------|
| ヘッダー INC ID | INC-0892 短縮 | INC-070C0148 (8文字) | △ | **改善** (前回 full UUID) |
| ヘッダー Duration | "Duration: 8m 14s" | "41h 14m" | OK | **改善** (前回なし) |
| Headline | 短い1行 | 長文 (LLM出力) | **NG** | 同 |
| Tag chips | 4つ | 3つ (98% exception, stripe) | △ | 同 |
| IMMEDIATE ACTION hero | 完備 | ✅ 表示 | OK | 同 |
| Why 説明 | 1行 | 長文 | △ | 同 |
| Do not | 1行 | 長文3行 | △ | 同 |
| Blast Radius 棒グラフ | 複数サービス | 1サービス (98%) | △ | 同 |
| Confidence | 85% + Risk | 85% + 長文説明 + Risk | OK | 同 |
| Operator Check | 3項目 | 8項目 | OK | 同 |
| Root Cause Hypothesis | 段落 | ✅ | OK | 同 |
| Causal Chain レイアウト | **横一列4段** + 色上線 + 破線コネクタ | **縦並び5段カード** + 色上線 + 破線コネクタ | **NG** | 同 |
| Causal Chain タイプ色 | amber/teal/accent | ✅ タイプ別色 | OK | 同 |
| Evidence 行 | ✅ | ✅ Traces 416 / Metrics 64 / Logs 460 | OK | 同 |
| Evidence タイムスタンプ | Started / Full cascade / Diagnosed | ✅ 表示 | OK | 同 |
| "Open Evidence Studio" | ✅ | ✅ | OK | 同 |
| **First viewport に全収容** | **✅ スクロール不要** | **❌ 1.3ページ分スクロール** | **NG** | 同 |

**L1 準拠率: ~60%** — 前回 (~55%) から微改善。Duration 表示追加と INC ID 短縮。Causal Chain 横レイアウトと first viewport 制約は未対応。

---

## L2 — Evidence Studio

| 要素 | Mock | Production | 準拠 | 3/22比 |
|------|------|-----------|------|--------|
| ヘッダー severity badge | ✅ CRITICAL | ✅ CRITICAL | OK | **改善** (前回なし) |
| ヘッダー Action 行 | "Action: Enable batching + backoff" | なし | **NG** | 同 |
| Proof Cards 構造 | 3枚横並び | 3枚横並び | OK | 同 |
| Proof Cards 説明テキスト | 各1行の要約 | ✅ 各カードに説明テキスト | OK | **改善** (前回なし) |
| Proof Cards click → trace | ✅ | 未検証 | — | — |
| Q&A 入力バー | `?` + input + 時刻 | 固定質問のみ、自由入力なし | **NG** | △改善 (前回完全欠落) |
| Q&A 回答ブロック | teal背景 + evidence note | deterministic answer 表示 | △ | **改善** (前回欠落) |
| Q&A Follow-up chips | 4つのボタン | 3つ (Open traces / Inspect metrics / Review logs) | △ | **改善** (前回欠落) |
| タブ Traces/Metrics/Logs | ✅ | ✅ | OK | 同 |
| **Evidence タブ click 操作** | ✅ | **NG — L1 から L2 への遷移でタブが遮蔽される** | **NG** | **新規発見** |
| Trace waterfall | ✅ | ✅ | OK | 同 |
| Trace expected vs observed | ✅ (数値比較) | ✅ "Observed 1679ms vs expected 122ms from 553 baseline" | OK | **改善** |
| **Span click → 展開** | Attributes + Correlated Logs | **✅ CORRELATED LOGS 表示** | △ | **大幅改善** (前回未実装) |
| **Span Attributes テーブル** | http.method, url, status_code 等 | **未実装** | **NG** | 同 |
| **Correlated Logs (±2s)** | span展開内に3-4行 | **✅ 表示** | OK | **大幅改善** (前回未実装) |
| **Smoking gun ハイライト** | 太ボーダー + 背景色 | なし | **NG** | 同 |
| **Baseline toggle** | "Show expected trace" + 正常trace waterfall | なし（数値比較はあり） | **NG** | 同 |
| Metrics タブ | hypothesis-grouped | ✅ hypothesis-grouped + expected vs observed | OK | 同 |
| Logs タブ | claim-clustered | ✅ claim cluster 表示 | OK | 同 |
| 右サイドバー Confidence | ✅ | ✅ | OK | 同 |
| 右サイドバー Uncertainty | ✅ | ✅ | OK | 同 |
| 右サイドバー Dependencies | "Affected Dependencies" | "External Dependencies" | △ | 同 |

**L2 準拠率: ~55%** — 前回 (~35%) から **大幅改善**。Span 展開 + Correlated Logs + Q&A 部分実装 + Proof Cards 説明テキスト + severity badge + expected vs observed。

---

## 全体準拠率サマリー

| レベル | 3/22 | 3/23 | 変化 | 主な改善 |
|--------|------|------|------|---------|
| L0 System Map | ~40% | ~40% | → | 変化なし（Map データ依存消失） |
| L1 Incident Board | ~55% | ~60% | ↑ | Duration 表示、INC ID 短縮 |
| L2 Evidence Studio | ~35% | ~55% | ↑↑ | Span 展開、Correlated Logs、Q&A 部分実装、Proof Cards 説明 |
| **全体** | **~43%** | **~52%** | **+9pt** | |

---

## 3/22 → 3/23 で改善された項目

1. **Span click → CORRELATED LOGS 展開** — L2 の最大の改善。前回は「何も起きない」
2. **Q&A 部分実装** — 完全欠落 → deterministic answer + follow-up chips 3つ
3. **Proof Cards 説明テキスト** — 名前+ステータスのみ → 各カードに要約1行
4. **Evidence Studio severity badge** — なし → CRITICAL 表示
5. **Trace expected vs observed** — 数値比較がグループヘッダーに表示
6. **Duration 表示** — L1 ヘッダーに経過時間
7. **Stats bar ラベル修正** — "Degraded Nodes" → "Degraded Services"

## 3/22 から未改善の項目

### Critical（操作導線が壊れている）

1. **Evidence タブ遮蔽** — L1 の Incident Board テキストが Evidence タブを物理的に隠し、クリック不能。`document.elementFromPoint()` がタブ座標で `<strong>Why:</strong>` を返す。**新規発見のバグ**
2. **Runtime Map 空表示** — SpanBuffer in-memory + cold start で全消失
3. **Q&A 自由入力なし** — Mock の中心的インタラクション。固定質問のみ

### Important（情報設計の差異）

4. **Causal Chain 横→縦** — Mock は横一列4段 + 破線コネクタ。Production は縦カード5段
5. **First viewport 制約違反** — L1 が 1.3 ページ分スクロール。Mock はスクロール不要
6. **Span Attributes テーブル** — http.method, status_code, ratelimit headers 等の KV 表示
7. **Smoking gun ハイライト** — 根本原因 span の視覚的強調
8. **Baseline toggle** — 正常時 trace との切替表示
9. **Headline 長文** — Mock は1行。Production は LLM 出力そのまま

### Minor

10. **ヘッダー Action 行** — L2 の "Action: Enable batching + backoff" 未実装
11. **INC ID** — Mock は INC-0892 (4桁)、Production は INC-070C0148 (8文字)
12. **右サイドバー ラベル** — "Affected" vs "External"

---

## 設計上の問題（前回から継続）

### Diagnosis 未完了時の体験

Production の diagnosis 未完了 incident（INC-413BDE8A）:
- L1: 全セクション「unavailable」表示。Blast Radius と severity tags は deterministic に出る
- L2: Proof Cards に説明テキスト付き（**改善**）。"Evidence is being collected..." メッセージ。Expected trace / baseline が unavailable 表示

前回指摘した「LLM なしでも箱が埋まっている状態が正しい」は依然として未達。ただし、L2 の degraded state メッセージは前回より丁寧になった。

### Evidence タブ遮蔽バグ（新規）

L1 (Incident Board) と L2 (Evidence Studio) が3カラムで並ぶとき、中央パネルのテキストが右パネルの Evidence タブを遮蔽する。URL パラメータ直書き以外でタブ切替不能。これは前回の監査時点では存在しなかった可能性がある（前回は別ブランチ）。

---

## スクリーンショット一覧

| ファイル | 内容 |
|---------|------|
| `audit-2026-03-23-mock/01-L0-map.png` | Mock L0 — 3段 Runtime Map + Stats + Incident Strip |
| `audit-2026-03-23-mock/02-L1-incident-board.png` | Mock L1 — Incident Board（first viewport 完収） |
| `audit-2026-03-23-mock/03-L2-evidence-studio.png` | Mock L2 — Evidence Studio (Q&A + Traces + Span展開) |
| `audit-2026-03-23-live/01-L0-map.png` | Production L0 — "No traffic observed yet." + 15 incidents |
| `audit-2026-03-23-live/02-L1-incident-board.png` | Production L1 — Incident Board 上部 |
| `audit-2026-03-23-live/02b-L1-bottom.png` | Production L1 — 下部（Root Cause + Causal Chain + Evidence） |
| `audit-2026-03-23-live/03-L2-evidence-studio.png` | Production L2 — Evidence Studio Traces タブ |
| `audit-2026-03-23-live/03b-L2-span-expanded.png` | Production L2 — Span 展開 + CORRELATED LOGS (**新機能**) |
| `audit-2026-03-23-live/03c-L2-metrics.png` | Production L2 — Metrics タブ |
| `audit-2026-03-23-live/03d-L2-logs.png` | Production L2 — Logs タブ |
| `audit-2026-03-23-live/04-L1-no-diagnosis.png` | Production L1 — diagnosis 未完了 |
| `audit-2026-03-23-live/05-L2-no-diagnosis.png` | Production L2 — diagnosis 未完了 Evidence Studio |
