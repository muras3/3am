# Production Audit Report — 2026-03-22 (REDO)

**Target:** `https://3am.vercel.app` (branch `feat/p0-p1-fixes-and-model-env`)
**Reference:** `docs/mock/lens-prototype-v1.html`
**Method:** Mock と Production を browser-use で同時に開き、スクリーンショットを目視比較。DOM存在チェックではなく、視覚的・機能的な準拠を確認。
**Timestamp:** 2026-03-22 11:23 UTC
**Previous audit:** 同日 02:07 UTC のレポートは方法論に致命的欠陥があり（DOM要素存在≠準拠）、全面やり直し。

---

## 方法論

前回の監査は `document.querySelector` による要素存在チェックのみで「100%準拠」と報告したが、実際にmockをブラウザで開いて1秒で3つの未実装機能が見つかった。

今回は以下の手順で実施：
1. Mock を `http://localhost:8765/lens-prototype-v1.html` でブラウザに表示
2. Production を `https://3am.vercel.app` でブラウザに表示
3. L0 → L1 → L2 の各画面をスクリーンショット撮影し、目視で比較
4. インタラクション（クリック、展開、タブ切替）も実際に操作して確認
5. スクリーンショットは `validation/e2e-screenshots/audit-redo-mock/` と `audit-redo-live/` に保存

---

## L0 — System Topology Map

### Mock の仕様
- Stats bar: Active Incidents / Degraded Services / Req/s (cluster) / P95 Latency
- Runtime Dependency Map: 3段構成（Entry Points / Runtime Units / Dependencies）
  - ノードは矩形、ステータス色分け（赤=critical, 黄=degraded, 緑=ok）
  - ノード間に SVG エッジ（実線=errors, 破線=degraded, 細実線=healthy）
  - Entry Points は左ボーダー3px（`n-entry`）、Runtime Units は角丸（`n-unit`）、Dependencies は破線ボーダー+`EXTERNAL`タグ
  - ノード内に名前 + req/s + エラー率 or ステータス
  - tier ラベル（ENTRY POINTS / RUNTIME UNITS / DEPENDENCIES）が縦書きで左端
- Incident Strip: INC短縮ID + headline + severity badge + 経過時間
- 凡例: entry point / runtime unit / dependency / errors / degraded / healthy
- Lens breadcrumb: Map > Incident > Evidence

### Production の状態
- Stats bar: **表示あり**（3 Active Incidents, 0 Degraded Nodes, 0 Req/s, 0ms）
- Runtime Map: **"No traffic observed yet."** — SpanBuffer が空のため全ノード消失
- Incident Strip: **3件表示**
- Breadcrumb: **表示あり**

### 差異一覧

| 要素 | Mock | Production | 準拠 |
|------|------|-----------|------|
| Stats bar 構造 | 4列表示 | 4列表示 | OK |
| Stats "Degraded Services" ラベル | "Degraded Services" | "Degraded Nodes" | **NG** — ラベル不一致 |
| Stats 値 | 2, 2, 866, 89ms | 3, 0, 0, 0ms | △ データ問題（SpanBuffer TTL切れ） |
| Map 3段ノードグラフ | Entry Points 3ノード / Runtime Units 2ノード / Dependencies 2ノード | "No traffic observed yet." | **NG** — データ依存で完全消失 |
| Map tier ラベル | ENTRY POINTS / RUNTIME UNITS / DEPENDENCIES（縦書き） | 表示不可（ノードなし） | **未検証** |
| Map ノード differentiation | entry=左3px border, unit=角丸, dep=破線+EXTERNAL | 表示不可 | **未検証** |
| Map SVG エッジ | 色分け実線/破線 | 表示不可 | **未検証** |
| Map 凡例 | entry point / runtime unit 等 6種 | 表示不可 | **未検証** |
| Incident Strip ID形式 | INC-0892（4桁連番） | INC-ED9F387E（UUID先頭8文字） | △ 機能的には同等 |
| Incident Strip ラベル | diagnosis headline（"Stripe Rate Limit Cascade"） | 一部 headline使用、一部 "validation-web"（diagnosis未完了分） | △ 部分的 |
| Incident severity badge | CRITICAL / MEDIUM 色分け | critical のみ表示 | △ |
| Incident click → L1遷移 | ✅ | ✅ | OK |
| Breadcrumb | Map > Incident > Evidence | Map > Incident > Evidence | OK |

**L0 準拠率: 約40%** — Map自体がデータ依存で消失しているため、UI構造の検証が不可能。Stats barとIncident Strip、Breadcrumbの基本構造のみ確認可。

---

## L1 — Incident Board

### Mock の仕様
- ヘッダー: `← Map` + `INC-0892` + severity badge + `Duration: 8m 14s`
- Headline: 1行のインシデント要約
- Tag chips: 影響率 + キーワード（68% checkout errors, stripe 429, payment-service, order-service）
- **IMMEDIATE ACTION** hero block:
  - 左アクセントボーダー（`--accent`色）
  - 太字 20px アクション文
  - 説明テキスト（why）
  - `Do not:` 警告行
- 3カラム: BLAST RADIUS（棒グラフ）/ CONFIDENCE（%表示+説明）/ OPERATOR CHECK（チェックリスト）
- ROOT CAUSE HYPOTHESIS: 段落テキスト
- CAUSAL CHAIN: **横一列4段** — External Trigger → Design Gap → Cascade → User Impact
  - 各段に色付き上線（external=amber, design=teal, cascade=accent, impact=accent）
  - 各段にタイプラベル + タイトル + 短い説明
  - 段間に `---▶` コネクタ（破線矢印）
- EVIDENCE: Traces XX (YY errors) / Metrics XX anomalous / Logs XX (YY errors) + 時間帯
- "Open Evidence Studio" ボタン

### Production の状態（diagnosis済み incident INC-ED9F387E）
- ヘッダー: `← Map` + `INC-ed9f387e-...（full UUID）` — **UUIDが長すぎる**
- Headline: ✅ diagnosis結果の what_happened テキスト（長文）
- Tag chips: ✅ 93% / exception / stripe
- IMMEDIATE ACTION: ✅ hero block表示、Why + Do not 付き
- 3カラム: ✅ Blast Radius / Confidence 85% / Operator Check（7項目）
- Root Cause Hypothesis: ✅ 表示
- Causal Chain: **縦並びカード形式** — 6段（mock は横4段）
- Evidence: ✅ 表示 + "Open Evidence Studio" ボタン

### Production の状態（diagnosis未完了 incident INC-B8CCBDEA）
- ヘッダー: full UUID表示
- Headline: **raw incident ID**（`inc_b8ccbdea-...`） — diagnosis未完了で headline がない
- Tag chips: 97% / exception / stripe（部分的に deterministic データ）
- IMMEDIATE ACTION: **空** — "Why:" のみ表示。アクション文なし
- Blast Radius: 97% 表示（✅ deterministic）
- Confidence: 60% Medium confidence — **不明な出自**（diagnosis なしなのに confidence がある）
- Operator Check: **空**
- Root Cause Hypothesis: **空**（ヘッダーのみ）
- Causal Chain: **空**（ヘッダーのみ）
- Evidence: ✅ Traces/Metrics/Logs カウント表示

### 差異一覧

| 要素 | Mock | Production (diagnosed) | Production (undiagnosed) | 準拠 |
|------|------|----------------------|------------------------|------|
| ヘッダー INC ID | INC-0892 短縮 | full UUID | full UUID | **NG** |
| ヘッダー Duration | "Duration: 8m 14s" | なし | なし | **NG** — 未実装 |
| Headline | 短い1行 | 長文（LLM出力そのまま） | raw UUID | **NG** — 長すぎ / 空 |
| Tag chips | 影響率+キーワード4つ | 3つ | 3つ | △ |
| IMMEDIATE ACTION 構造 | hero block 完備 | ✅ 表示 | **空枠のみ** | △ |
| Do not 行 | 1行 | 長文3行 | なし | △ |
| Blast Radius 棒グラフ | 複数サービス棒グラフ | 1サービスのみ | 1サービスのみ | △ |
| Confidence 数値 | 85%（コンパクト）+ Risk行 | 85%（長文説明） | 60%（出自不明） | △ |
| Operator Check | 3項目 | 7項目 | **空** | △ |
| Root Cause Hypothesis | 段落テキスト | ✅ | **空枠** | △ |
| Causal Chain レイアウト | **横一列4段** + 色付き上線 + 破線コネクタ | **縦並び6段カード** | **空枠** | **NG** — レイアウト根本的に異なる |
| Causal Chain タイプ色 | external=amber, design=teal, cascade=accent, impact=accent | 色付き上線あり | N/A | △ 部分的 |
| Evidence 行 | ✅ | ✅ | ✅ | OK |
| "Open Evidence Studio" ボタン | ✅ | ✅ | ✅ | OK |

**L1 準拠率: 約55%** — 構造は大枠存在するが、Causal Chain のレイアウトが根本的に異なる（横→縦）。diagnosis未完了時は大半が空枠表示で、deterministic fallback が不十分。

---

## L2 — Evidence Studio

### Mock の仕様
- ヘッダー: `← INC-0892` + `Evidence Studio` + severity badge + `Action: Enable batching + backoff`
- **Proof Cards** (3枚横並び):
  - External Trigger — CONFIRMED — 説明テキスト1行
  - Design Gap — CONFIRMED — 説明テキスト1行
  - Recovery Signal — INFERRED — 説明テキスト1行
  - 各カードにアイコン（⚡/⚠/✓）
  - クリックで対応 trace にスクロール
- **Q&A Frame**:
  - 質問入力バー（`?` アイコン + input + 時刻バッジ）
  - 回答ブロック（teal背景、evidence note 付き）
  - Follow-up chips（4つ: "Is there retry logic?" / "When exactly did this start?" / "What's the full blast radius?" / "Will batching actually fix this?"）
- **タブ**: Traces / Metrics / Logs
- **Traces タブ**:
  - `Observed (Incident)` ラベル + deviation 説明
  - Trace waterfall（span 棒グラフ、赤=error, 黄=slow, 緑=ok）
  - **Smoking gun span** ハイライト（太いボーダー）
  - **Span click → 展開**:
    - **Span Attributes** テーブル（http.method, http.url, http.status_code, x-ratelimit-limit, x-ratelimit-remaining, retry-after, span.status）
    - **Correlated Logs (±2s)** — 同じ時間帯のログ3-4行 + "View all 12 correlated logs →" リンク
  - **Baseline toggle**: "Show expected trace (200, 245ms — 14:20:02)" → 正常時の trace waterfall 表示
- **右サイドバー**:
  - Confidence（テキスト）
  - Uncertainty（テキスト）
  - Affected Dependencies（モノスペースリスト）

### Production の状態（diagnosis済み INC-ED9F387E）
- ヘッダー: `← INC-ed9f387e-...` + `Evidence Studio` — **severity badge なし、Action 行なし**
- Proof Cards: 3枚表示（Trigger Evidence / Design Gap / Recovery Path）
  - **名前+ステータスのみ** — 説明テキストなし
  - アイコンあり（⚡/⚠/✓）
- "Narrative is being generated. Evidence surfaces are available below." メッセージ
- **Q&A Frame: 完全に欠落** — 入力バーなし、回答ブロックなし、follow-up chips なし
- タブ: Traces 13 / Metrics 4 / Logs 100 ✅
- Traces タブ:
  - Trace waterfall ✅ span棒グラフ表示
  - **Span click → 何も起きない** — detail展開未実装
  - **Span Attributes テーブル: 未実装**
  - **Correlated Logs (±2s): 未実装**
  - **Smoking gun ハイライト: 未実装**
  - **Baseline toggle ("Show expected trace"): 未実装**
- Metrics タブ: メトリクス名+値+expected値のテーブル表示 ✅
- Logs タブ: フラットなログ行リスト ✅
- 右サイドバー: Confidence / Uncertainty / External Dependencies ✅

### Production の状態（diagnosis未完了 INC-B8CCBDEA）
- ヘッダー: full UUID + Evidence Studio
- Proof Cards: 3枚（名前+ステータスのみ）
- "Diagnosis not available yet. Evidence is being collected." メッセージ
- **Q&A Frame: 欠落**
- Traces/Metrics/Logs: ✅ データ表示
- 右サイドバー: External Dependencies のみ（Confidence/Uncertainty なし — diagnosis依存のため正しい）

### 差異一覧

| 要素 | Mock | Production | 準拠 |
|------|------|-----------|------|
| ヘッダー severity badge | ✅ CRITICAL 表示 | なし | **NG** |
| ヘッダー Action 行 | "Action: Enable batching + backoff" | なし | **NG** |
| Proof Cards 構造 | 3枚 横並び | 3枚 横並び | OK |
| Proof Cards 説明テキスト | 各1行の要約 | **なし**（名前+ステータスのみ） | **NG** |
| Proof Cards クリック→trace スクロール | ✅ | 未実装 | **NG** |
| **Q&A 入力バー** | `?` + input + 時刻 | **完全欠落** | **NG — 未実装** |
| **Q&A 回答ブロック** | teal背景 + evidence note | **完全欠落** | **NG — 未実装** |
| **Q&A Follow-up chips** | 4つのボタン | **完全欠落** | **NG — 未実装** |
| タブ構造 | Traces / Metrics / Logs | Traces / Metrics / Logs | OK |
| Trace waterfall 表示 | ✅ | ✅ | OK |
| **Smoking gun span ハイライト** | 太ボーダー + 背景色 | なし | **NG — 未実装** |
| **Span click → detail 展開** | ✅ Attributes + Logs | **何も起きない** | **NG — 未実装** |
| **Span Attributes テーブル** | http.method, url, status_code 等 | **未実装** | **NG — 未実装** |
| **Correlated Logs (±2s)** | span展開内に3-4行 | **未実装** | **NG — 未実装** |
| **Baseline toggle** | "Show expected trace" + 正常trace | **未実装** | **NG — 未実装** |
| 右サイドバー Confidence | ✅ | ✅ | OK |
| 右サイドバー Uncertainty | ✅ | ✅ | OK |
| 右サイドバー Affected Dependencies | ✅ | ✅（"External Dependencies"ラベル） | △ ラベル微妙に違う |

**L2 準拠率: 約35%** — Evidence Studio の核心機能（Q&A、span展開、correlated logs、smoking gun、baseline比較）がすべて未実装。Trace waterfall の構造表示とサイドバーのみ一致。

---

## 全体準拠率サマリー

| レベル | 準拠率 | 主な問題 |
|--------|--------|---------|
| L0 System Map | ~40% | Map本体がデータ依存で消失、tier分類・ノード differentiation 未検証 |
| L1 Incident Board | ~55% | Causal Chain レイアウト根本差異（横→縦）、diagnosis未完了時に空枠多数 |
| L2 Evidence Studio | ~35% | Q&A完全欠落、span展開未実装、correlated logs未実装、baseline比較未実装 |
| **全体** | **~43%** | |

---

## 未実装機能リスト（Mock にあり Production にない）

### Critical（UIの核心機能）

1. **Q&A Frame** — Evidence Studio の質問入力 + 回答 + follow-up chips。完全に未実装。Mock では L2 の中心的なインタラクション要素
2. **Span click → detail 展開** — Trace waterfall 内の span をクリックしても何も起きない。Mock では Span Attributes テーブルと Correlated Logs が展開する
3. **Correlated Logs (±2s)** — span 展開内に表示される時間相関ログ。未実装
4. **Span Attributes テーブル** — http.method, http.url, http.status_code, x-ratelimit 等のキーバリュー表示。未実装
5. **Baseline toggle ("Show expected trace")** — 正常時の trace との比較表示。未実装
6. **Smoking gun span ハイライト** — 根本原因 span の視覚的強調。未実装

### Important（情報密度・ナビゲーション）

7. **Causal Chain 横レイアウト** — Mock は横一列4段（Trigger → Gap → Cascade → Impact）+ 破線コネクタ。Production は縦並びカードリスト
8. **Proof Cards 説明テキスト** — Mock は各カードに1行の要約テキスト。Production は名前+ステータスのみ
9. **Proof Cards click → trace スクロール** — Mock ではカードクリックで対応 trace にジャンプ。未実装
10. **ヘッダー Duration** — L1 ヘッダーの "Duration: 8m 14s" 表示。未実装
11. **ヘッダー Action 行** — L2 ヘッダーの "Action: Enable batching + backoff"。未実装
12. **L1 Headline 短縮** — Mock は1行。Production は LLM 出力の長文がそのまま表示
13. **INC ID 短縮** — Mock は INC-0892（4桁連番）。Production は full UUID ヘッダー表示

### Minor（デザイン差異）

14. **Stats bar ラベル** — "Degraded Services" vs "Degraded Nodes"
15. **右サイドバー ラベル** — "Affected Dependencies" vs "External Dependencies"
16. **L2 severity badge** — ヘッダーに severity badge がない

---

## 設計上の問題

### A-1: LLM依存 → UI崩壊パターン

Diagnosis未完了のincidentで以下が **空枠** になる：
- Headline（raw UUIDが表示される）
- IMMEDIATE ACTION（空）
- Operator Check（空）
- Root Cause Hypothesis（空枠）
- Causal Chain（空枠）

**これらのうち deterministic に生成できるデータが存在するのに、LLM出力に依存している。**
例: Blast Radius (97%) と severity tags は deterministic に表示される一方、Headline は diagnosis result の `what_happened` に完全依存。

Incident Board は「LLMなしでも箱が埋まっている」状態が正しい設計。LLM結果は箱の中身をリッチにするだけ。

### A-2: Evidence Studio の Q&A が完全に存在しない

Mock の Evidence Studio は Q&A Frame が中心的なインタラクション要素。質問入力 → 回答 → follow-up chips で「なぜこの原因か」を掘り下げる導線。

Production にはこの UI コンポーネント自体が存在しない（HTML/CSS/JSレベルで未実装）。

### A-3: Span 展開 = Evidence Studio の価値の半分

Mock では trace waterfall の span をクリックすると：
- Span Attributes（http.method, status_code, ratelimit headers 等）
- Correlated Logs (±2s)（同時刻のログ3-4行）

が展開表示される。これが「なぜこの span が問題か」を証拠付きで示す Evidence Studio の核心機能。

Production では span は表示されるが **クリックしても何も起きない**。waterfall は見た目だけの飾り。

---

## スクリーンショット一覧

| ファイル | 内容 |
|---------|------|
| `audit-redo-mock/01-L0-map.png` | Mock L0 — 3段 Runtime Map + Stats + Incident Strip |
| `audit-redo-mock/02-L1-incident-board.png` | Mock L1 — Incident Board 全体 |
| `audit-redo-mock/03-L2-evidence-studio.png` | Mock L2 — Evidence Studio（Q&A + Traces + Span展開） |
| `audit-redo-live/01-L0-map.png` | Production L0 — "No traffic observed yet." |
| `audit-redo-live/02-L1-incident-board.png` | Production L1 — Incident Board 上部 |
| `audit-redo-live/02b-L1-middle.png` | Production L1 — 中間（Blast Radius/Confidence/Operator Check） |
| `audit-redo-live/02c-L1-bottom.png` | Production L1 — 下部（Root Cause + Causal Chain） |
| `audit-redo-live/02d-L1-very-bottom.png` | Production L1 — 最下部（Causal Chain + Evidence） |
| `audit-redo-live/03-L2-evidence-studio.png` | Production L2 — Evidence Studio（Traces タブ） |
| `audit-redo-live/03b-L2-metrics-tab.png` | Production L2 — Metrics タブ |
| `audit-redo-live/03c-L2-logs-tab.png` | Production L2 — Logs タブ |
| `audit-redo-live/04-L1-no-diagnosis.png` | Production L1 — diagnosis未完了（空枠多数） |
| `audit-redo-live/05-L2-no-diagnosis.png` | Production L2 — diagnosis未完了の Evidence Studio |
