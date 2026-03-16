# Develop Re-evaluation — 2026-03-16

- Target: `origin/develop` (`0654d27`)
- Reviewer: **Claude Opus 4.6**
- Prior review: Opus 2026-03-14 (`46aef84`) + Codex 2026-03-14
- Delta: 38 commits, 12 PRs merged, +3,528/-321 lines, 55 files
- Scope: Full re-evaluation + UIUX deep audit

---

## Executive Summary

2日間で 12 PRs をマージし、incident packet の canonical model 品質を大幅に向上（B-2/B-4/B-5/B-6/A-3 完了）。ビルドは完全 green に回復（542 tests, 0 type errors）。

しかし UIUX deep audit により **致命的なレイアウトバグ群** が発見された。incident board のセンターカラムが **スクロール不能** であり、診断結果が長い場合にコンテンツが見切れる。これは CSS セレクタのミスマッチ (`.center-board` が DOM に存在しない) に起因する。加えて、activity stream の CSS が **完全に未定義**、デザインスペックとの乖離（3カラム bottom grid 未実装）、アクセシビリティ欠陥（focus 管理なし、Error Boundary なし）など、console UI には構造的な品質問題が多数ある。

診断エンジンの運用耐性（retry/timeout）は ADR 0019 v2 で contract 化済み、実装は PR #83 で進行中。

---

## QCD 比較

| 軸 | 03-14 | 03-16 | トレンド |
|---|---|---|---|
| **Quality** | High (degradation signals) | **Mixed** — backend 回復、frontend 深刻な負債露出 | → |
| **Cost** | Acceptable (rising) | Acceptable | → |
| **Delivery** | Strong (decelerating) | **Strong** (12 PRs/2日) | ↗ |

---

## ビルド健全性

| チェック | 03-14 | 03-16 |
|---|---|---|
| typecheck | RED | **GREEN** (0 errors) ✅ |
| build | RED | **GREEN** (5/5) ✅ |
| test | 503 passed | **542 passed** (+7.7%) ✅ |
| lint | GREEN | **GREEN** ✅ |

---

## Incident Packet: 大幅改善

| 項目 | 03-14 | 03-16 |
|---|---|---|
| B-2: representativeTraces 先頭10件のみ | open | **done** — 2-stage ranking ✅ |
| B-4: Evidence が `z.unknown[]` | open | **done** — typed schemas ✅ |
| B-5: retrieval layer が空 | open | **done** — 全ポインタ populated ✅ |
| B-6: severity optional/未設定 | open | **done** — signalSeverity enum ✅ |
| A-3: Platform events dead code | open | **done** — 統合 + ADR 0031 ✅ |
| A-1/A-2/B-1/B-3 | open | open |

Packet は canonical model として実用水準に近づいた。

---

## 診断エンジン: ADR 改訂済み、実装待ち

ADR 0019 v2 (PR #83) で以下を contract 化：
- callModel: 120s timeout + max 2 retry (429/529 のみ)
- parseResult: 出力サイズ制約 (causal_chain ≤8, strings ≤2,000)
- buildPrompt: platformEvents.details 1,000 文字切り詰め

実装は PR #83 に追加コミット予定。

---

## Console UIUX: Deep Audit 結果

### CRITICAL — スクロール不能バグ

**症状:** incident board のセンターカラムで、診断結果のテキスト量が viewport を超えるとコンテンツが見切れ、スクロールもできない。

**原因チェーン:**
1. `reset.css:3` — `html, body { overflow: hidden }` でドキュメントスクロール無効
2. `shell.css:237` — `.center-incident` に `overflow-y: auto` はあるが flex column で高さ制約が曖昧
3. `board.css:1-2` — `.center-board > * { flex-shrink: 0 }` がある**が `.center-board` クラスが DOM に存在しない**（セレクタ空振り）
4. `IncidentBoard.tsx` — 各セクションが `.center-incident` の直接 flex children として展開、shrink も max-height も効かない

**影響:** incident 対応ツールとして致命的。operator が画面を開いても Immediate Action が見切れる可能性がある。

---

### CRITICAL — Activity Stream CSS 未定義

**ファイル:** `NormalSurface.tsx:82-97`

Normal mode の activity stream が以下のクラスを使用：
- `.activity-stream`, `.activity-row`, `.act-time`, `.act-svc`, `.act-code`, `.act-route`, `.act-dur`

**これらの CSS が一切定義されていない。** レイアウトなし、カラム整列なし、hover なし。テキストが重なって表示される。

---

### CRITICAL — 未定義 CSS 変数

| ファイル | 行 | 変数 | 問題 |
|---|---|---|---|
| `shell.css` | 538 | `var(--ink-1)` | 存在しない。`--ink`, `--ink-2`, `--ink-3` のみ定義 |
| `shell.css` | 567 | `var(--bg-2)` | 存在しない。`--bg`, `--panel`, `--panel-2`, `--panel-3` のみ定義 |

ブラウザはフォールバックなしで無視するため、色が適用されない。

---

### CRITICAL — デザインスペック乖離

| スペック要素 | mock HTML の設計 | 実装 | 影響 |
|---|---|---|---|
| **Bottom 3-column grid** | Mitigation Watch \| Impact & Timeline \| Evidence Preview の3カラム | **未実装** — RecoveryCard/CauseCard/EvidenceEntry が全幅で縦積み | first viewport の情報密度が大幅低下。スクロール不能バグと合わせて致命的 |
| **Impact & Timeline card** | タイムラインイベント表示 | **未実装** | operator がインシデントの時間経過を Board で確認できない |
| **Evidence Preview サマリ** | "Metrics queue and 504 curves bend together" 等のテキストヒント | **未実装** — 件数のみ ("18 spans captured") | Evidence Studio を開く前に evidence の意味が分からない |
| **Immediate Action font** | 20px / 700 weight | 18px / 800 weight | hero 要素の視覚的 prominence が仕様より弱い |
| **セクションラベル** | "Why This Action" | "Root Cause" | 因果チェーンセクションのラベルがスペックと不一致 |

---

### HIGH — テキストオーバーフロー（複数コンポーネント）

以下のコンポーネントで `word-break`, `overflow-wrap`, `max-height` がなく、長いテキストが container を突き破る：

| コンポーネント | フィールド | リスク |
|---|---|---|
| `ImmediateAction.tsx:11` | `.action-text` (18px bold) | LLM の immediate_action が長文の場合、カード内でオーバーフロー |
| `CauseCard.tsx:31-32` | `.step-main`, `.step-meta` | chain step が横並びで均等幅のため、30文字超のタイトルが溢れる |
| `WhatHappened.tsx:12` | `.headline` (15px bold) | 180文字超の what_happened が折り返し制御なし |
| `RecoveryCard.tsx:20` | `.recovery-look` | 長い watch_item label が status badge を押し出す |
| `ProofCards.tsx:12-14` | `.proof-card-proof`, `.proof-card-detail` | 3等分カラムで長い proof テキストが溢れる |

---

### HIGH — アクセシビリティ欠陥

| 問題 | ファイル | 行 |
|---|---|---|
| **focus 表示なし** — chat input が `outline:none; border:none` で `:focus-visible` 代替なし | `shell.css` | 539 |
| **全ボタンに `:focus-visible` なし** — `.btn-close`, `.btn-evidence`, `.send-btn`, `.ask-chip` 等 | `shell.css` | 全域 |
| **Evidence Studio に focus trap なし** — Tab で modal 外に抜ける | `EvidenceStudio.tsx` | 22-28 |
| **Evidence Studio の focus 復帰なし** — 閉じた後 focus が迷子 | `EvidenceStudio.tsx` | 22-28 |
| **Evidence tabs に role="tab" / aria-selected なし** | `EvidenceTabs.tsx` | 11-19 |
| **Error メッセージに role="alert" なし** | `RightRail.tsx` | 94-96 |
| **React Error Boundary なし** — lazy component の render error で全画面クラッシュ | `AppShell.tsx` | 97-103 |

---

### HIGH — Query 設定の不備

| 問題 | ファイル |
|---|---|
| **refetchInterval なし** — incident 対応中にデータが auto-refresh されない | `queries.ts:28-56` |
| **QueryClient デフォルト設定** — retry:3 (30秒 invisible delay) が本番にも適用 | `main.tsx:8` |
| **gcTime 未設定** — 古いクエリデータが無期限に残存 | `queries.ts` |
| **fetch timeout なし** — サーバー hang で無限待ち | `api/client.ts` |

---

### MEDIUM — Dead CSS / 不整合

| 問題 | ファイル | 行 |
|---|---|---|
| `.center-board > *` セレクタ空振り | `board.css` | 1-2 |
| `.chat-input` (未使用、`.chat-input-row` が実体) | `shell.css` | 514-527 |
| `.empty-state`, `.loading` 定義済み未使用 | `shell.css` | 589-596 |
| Geist font import 残存 (DM Sans が canonical) | `global.css` | 9 |
| `--radius` Tailwind (10px) vs tokens (6px) の暗黙 override | `global.css` | 37, 149 |
| hardcoded `#fff0ee` (token 外) | `shell.css` | 571 |
| `.chain-step { z-index:1 }` position なしで無効 | `board.css` | 143 |

---

### MEDIUM — Evidence Studio

| 問題 | ファイル |
|---|---|
| Modal `height:calc(100vh - 80px)` と `max-height:760px` のロジック矛盾 | `board.css:217` |
| 768px 以下で `grid-template-columns:1fr 260px` が破綻 (responsive 対応なし) | `board.css:323` |
| Traces の spanId truncation が JS ハードコード (12文字) で CSS fallback なし | `TracesView.tsx:55` |

---

### LOW — UX 改善余地

| 問題 | ファイル |
|---|---|
| Metrics empty state が内部エンドポイント名 `/v1/metrics` を表示 | `MetricsView.tsx:31` |
| Chat input の Enter 送信ヘルプテキストなし | `RightRail.tsx:123` |
| `prefers-reduced-motion` 対応あり (good) | `shell.css:600-616` |

---

## スコアリング比較

| 次元 | 03-14 | 03-16 | 変化 | 備考 |
|---|---|---|---|---|
| Architecture | A | **A** | → | |
| Code quality (backend) | B+ | **A-** | ↗ | typed evidence, signalSeverity |
| Code quality (frontend) | B | **C+** | ↘ | deep audit で構造的問題露出 |
| Test quality | B+ | **A-** | ↗ | 542 tests |
| Security posture | B | **B** | → | CORS/CSP 未着手 |
| Packet model | C+ | **B+** | ↗↗ | 5 remediation items 完了 |
| Diagnosis engine | B | **B** | → | ADR 改訂済み、実装待ち |
| Console UX | B | **D+** | ↘↘ | スクロール不能 + CSS 未定義 + スペック乖離 |
| Product maturity | C+ | **C+** | → | frontend 品質低下が相殺 |
| Process quality | A- | **A** | ↗ | |
| **Overall** | **B+** | **B** | ↘ | frontend 負債が overall を引き下げ |

**前回 B+ → 今回 B。** backend の改善を frontend の構造的問題が相殺。

---

## UIUX 課題の優先度整理

### P0 — operator が使えない

| # | 課題 | 影響 |
|---|---|---|
| U-1 | センターカラム スクロール不能 | 診断結果が見切れる |
| U-2 | Activity stream CSS 未定義 | normal mode が壊れている |
| U-3 | 未定義 CSS 変数 (`--ink-1`, `--bg-2`) | 色が適用されない |

### P1 — first viewport の情報密度

| # | 課題 | 影響 |
|---|---|---|
| U-4 | Bottom 3-column grid 未実装 | スペック設計の情報密度が実現できていない |
| U-5 | Impact & Timeline card 未実装 | 時間経過を Board で確認不可 |
| U-6 | Evidence Preview サマリなし (件数のみ) | Studio を開かないと evidence の意味不明 |
| U-7 | テキストオーバーフロー (5コンポーネント) | 長い診断結果でレイアウト崩壊 |
| U-8 | Immediate Action 18px → 20px (スペック準拠) | hero の prominence 不足 |
| U-9 | refetchInterval なし | incident 中に auto-refresh されない |
| U-10 | Error Boundary なし | lazy component crash で全画面白 |

### P2 — アクセシビリティ・品質

| # | 課題 | 影響 |
|---|---|---|
| U-11 | focus 表示なし (全 interactive 要素) | キーボードユーザーが操作不能 |
| U-12 | Evidence Studio focus trap/復帰なし | modal の a11y 違反 |
| U-13 | Evidence tabs role/aria なし | スクリーンリーダー非対応 |
| U-14 | QueryClient デフォルト設定 | retry 3回 = 30秒 invisible delay |
| U-15 | Dead CSS 整理 | 保守性低下 |
| U-16 | Font split (Geist import 残存) | dead dependency |
| U-17 | radius 値の Tailwind/tokens 不整合 | shadcn と custom CSS でボーダー半径が違う |

---

## 次のアクション推奨

1. **UIUX P0 (U-1〜U-3) を最優先で修正** — 現状 console が壊れている
2. **P0 診断 resilience (PR #83)** を並行で実装
3. **UIUX P1 (U-4〜U-10)** をまとめて 1 PR — スペック準拠 + operational basics
4. **UIUX P2 (U-11〜U-17)** を別 PR — a11y + cleanup

---

## 結論

backend は着実に前進しているが、frontend は deep audit で **想定以上の構造的問題** が露出した。スクロール不能バグ、CSS 未定義、デザインスペックとの大幅乖離は、前回レビューの Console UX: B 評価が楽観的だったことを示している。

最大のリスクは「demo や実運用で operator が画面を開いたときに、診断結果が見切れて読めない」という基本的な失敗。packet と diagnosis の品質がどれだけ高くても、表示が壊れていれば価値がゼロになる。

**frontend の品質を backend に追いつかせることが、次フェーズの最優先事項。**

---

*Reviewed by Claude Opus 4.6 — 2026-03-16*
