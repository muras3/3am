# Railway Staging プロダクト検証レポート

- Date: 2026-03-23
- Target: `https://3am-production.up.railway.app`
- Method: API (curl) + browser-use (headless Chromium 1512x982)
- Incident tested: `inc_070c0148` (rate_limit_cascade, critical, with diagnosis)
- Empty state tested: `inc_413bde8a` (medium, diagnosis unavailable)

---

## プロダクト評価

> **3am の約束: 「午前3時に叩き起こされたエンジニアが、5分以内に原因を特定し、正しい初動を取れるようにする」**

この約束が、実際のユーザー体験として果たされているかを評価する。

### ユーザー導線で見た評価

**Step 1: Console を開く — 何が起きているか把握する**

「15 Active Incidents」の数字は見える。しかし画面の主役である Runtime Dependency Map は「No traffic observed yet.」と空。serverless の cold start で SpanBuffer がリセットされるため、どのサービスが壊れているかを一目で把握する体験は成立しない。

incident list は存在するが、15件全部 open のまま並んでおり、優先度の判断材料が薄い。severity の色分け (CRITICAL/HIGH/MEDIUM) はあるが、truncated な長文 headline が並ぶだけで、「今どれを見るべきか」が直感的にわからない。

→ **「全体を把握する」体験は成立していない。**

**Step 2: Incident をクリックする — 何をすべきかわかる**

**ここはプロダクトの核であり、強い。** Headline で状況がわかる。Immediate Action が「1) Stripe へのリトライを即停止 2) 閾値超えリクエストを shed 3) Stripe に連絡 4) backoff 付きで再開」と具体的。Why で「backoff なしのリトライは正のフィードバックループだから止める」と説明される。Do not で「worker pool を増やすな — Stripe への要求を増やして悪化する」と警告される。

76秒で診断が完了している。「5分以内」の約束は余裕を持って果たしている。

しかし、**この情報が first viewport に収まっていない。** Causal Chain、Root Cause Hypothesis、Evidence セクションはスクロールしないと見えない。figma-brief は「ページ全体の縦スクロール禁止」「first viewport で重要情報」と明確に定義しているが、実装は 1.3 ページ分スクロールする。3am にスクロールして因果関係を読み解くのは、「5秒で理解」の約束に反する。

→ **「何をすべきか」はわかる。「なぜそうなったか」に到達するのが遅い。**

**Step 3: Evidence で診断根拠を確認する — 本当にそうか検証する**

**ここが壊れている。** Traces タブは見えるが、Metrics や Logs に切り替えるタブが Incident Board のテキスト要素に物理的に隠れてクリックできない。`document.elementFromPoint()` がタブの座標で `<strong>Why:</strong>` を返す。URL を手書きで `?tab=metrics` に変えないと切り替わらない。3am にそれはやらない。

URL 直遷移で Evidence Studio を開くと、中身は良い。Traces の expected vs observed（122ms → 1679ms、553 baseline samples）は「正常時と比べてどれだけ異常か」が一目でわかる。Metrics の hypothesis-grouped テーブルも、worker_pool_in_use が expected 1 に対して 16（フル使用）という差分が明確。Logs は claim cluster で「payment dependency rate limited」が 58 entries と集約されている。

**データの質は高い。見られれば価値がある。見られない。**

→ **Evidence 確認の導線は壊れている。**

**Step 4: AI に質問する — わからないことを聞く**

「Diagnosis narrative is not attached to this incident yet.」と表示される。Q&A に質問しても grounded answer が返る保証がない。AI Copilot は product-concept で定義された機能だが、機能していない。

→ **AI Copilot は未完成。**

**Step 5: Diagnosis なしの incident を見る**

「Diagnosis is unavailable for this incident.」と全セクションに表示される。Blast Radius, Confidence, Operator Check, Root Cause, Causal Chain すべて「unavailable」。チップ (http_401, sendgrid) から何かが起きたことはわかるが、何をすべきかはわからない。

診断が届いていない incident は、このプロダクトの価値がゼロになる。webhook + 診断ランタイムの連結が切れたときの fallback が「全部 unavailable」では、3am のエンジニアは何も得られない。

→ **診断未到達時の体験が設計されていない。**

---

### 約束 vs 現実

| 約束 | 現実 |
|------|------|
| 5分以内に根本原因と初動アクション | **果たしている。** 76秒で具体的アクション。これは本物の価値 |
| 5秒で「何が・何をすべき・なぜ」を理解 | **果たしていない。** first viewport に収まらない。スクロール必須 |
| Evidence で診断根拠を検証できる | **果たしていない。** タブ切替が壊れている。URL 手書き以外でアクセス不能 |
| AI Copilot で質問できる | **果たしていない。** narrative 未接続 |
| Runtime Map で全体把握 | **果たしていない。** cold start で常に空 |
| Datadog に負けない UI/UX | **まだ遠い。** 基本操作が壊れている箇所がある |

### 総評

**コア診断エンジンは約束を果たしている。** 76秒で的確な root cause と具体的な 4 ステップアクションを出す。Operator Check は実用的で、Do not の警告は dangerous suggestion を防ぐ。Causal Chain は因果を型付きで構造化しており、診断結果そのものの質は高い。

**Console はその価値を届ける器として、まだ成立していない。** Evidence タブの遮蔽は操作不能レベルのバグ。first viewport 制約の違反は「5秒理解」の設計原則に反する。Runtime Map の空表示と AI Copilot の未接続は、Normal mode と Evidence mode の両方で体験を損なっている。

**今の状態で「プロダクト」として人に見せられるのは、Incident Board の Immediate Action セクションだけ。** そこは確かに良い。残りは動くデモであってプロダクトではない。

---

---

## 付録: 技術検証詳細

以下は API contract / DOM 要素 / data requirements の技術的な準拠確認。プロダクト評価の補足資料。

### A-1. Core Value (product-concept-v0.2 §2)

| 定義 | 実装状態 | 判定 |
|------|---------|------|
| OTel ingest (OTLP/HTTP protobuf + JSON) | /v1/traces, /v1/metrics, /v1/logs 全動作 | **OK** |
| 異常検知 (OTel-native ルールベース) | incident 15件が自動生成されている | **OK** |
| Incident packet 生成 | packet 内に window/scope/evidence/triggerSignals 全存在 | **OK** |
| LLM 診断 (v5 prompt) | 5件の critical incident に完全な診断結果 | **OK** |
| 5分以内の初動提案 | inc_070c0148: opened 14:30:52 → diagnosed 14:32:08 (76秒) | **OK** |
| Incident Console (incident-scoped) | traces/metrics/logs を incident 単位で表示 | **OK** |
| 最大3日保持 | 6日前の incident もまだ残っている（保持期間制限未実装?） | **要確認** |

### A-2. Incident Board (figma-brief "What Must Be On The Board")

| 必須要素 | 実装状態 | 判定 |
|---------|---------|------|
| What happened (headline) | "validation-web began receiving HTTP 429..." + severity chips | **OK** |
| Immediate Action | 4ステップの具体的アクション、左ボーダー強調 | **OK** |
| Why this action (rationale) | "Retrying against a rate-limited dependency without backoff..." | **OK** |
| Root cause hypothesis | "Stripe rate-limited validation-web (HTTP 429)..." | **OK** |
| Operator check | 8項目のチェックリスト（checkbox付き） | **OK** |
| Do not | "Do NOT increase worker pool size..." | **OK** |
| Open Evidence Studio | Evidence Studio がインライン表示 + Lens 遷移で全画面化 | **OK** |

### A-3. Evidence Studio (figma-brief §3 "Evidence realism")

| 要件 | 実装状態 | 判定 |
|------|---------|------|
| Metrics: real timeseries charts | hypothesis-grouped テーブル (observed vs expected)。チャートではなくバー表示 | **部分OK** |
| Traces: waterfall with span names + durations | span waterfall 表示 (checkout.request→payment.charge 連鎖) | **OK** |
| Traces: expected vs observed | "Observed 1679ms vs expected 122ms from 553 baseline samples" | **OK** |
| Logs: explorer-like rows | timestamp + severity + message の行表示 | **OK** |
| Proof cards | Trigger Evidence (CONFIRMED), Design Gap (INFERRED), Recovery Path (PENDING) | **OK** |
| Q&A (grounded proof query) | 質問+回答表示あり。ただし "narrative is not attached" 表示 | **部分OK** |
| Confidence/Uncertainty side notes | 右サイドに Confidence (90%) + Uncertainty + External Dependencies | **OK** |

### A-4. Console Data Requirements (console-data-requirements.md)

| Contract | 実装状態 | 判定 |
|---------|---------|------|
| Normal: summary stats | activeIncidents=15, degradedNodes=0, clusterReqPerSec=0, clusterP95Ms=0 | **OK** (SpanBuffer empty で 0) |
| Normal: map nodes/edges | 構造あり、SpanBuffer cold start で空配列 | **部分OK** |
| Incident: impactSummary | startedAt/fullCascadeAt/diagnosedAt 全存在 | **OK** |
| Incident: blastRadius | validation-web 98% 表示 | **OK** |
| Incident: confidenceSummary | label/value/basis/risk 全存在 | **OK** |
| Incident: evidenceSummary | traces=416, traceErrors=406, metrics=64, logs=460, logErrors=83 | **OK** |
| Incident: state | diagnosis=ready, baseline=ready, evidenceDensity=rich | **OK** |
| Evidence: proofCards | trigger/design_gap/recovery_path + evidenceRefs (span/log refs) | **OK** |
| Evidence: surfaces.traces | observed trace groups + expected baseline + smokingGun span | **OK** |
| Evidence: surfaces.metrics | hypothesis-grouped with observed/expected values | **OK** |
| Evidence: surfaces.logs | claim clusters (validation-web warn logs: 58 entries) | **OK** |

### A-5. API エンドポイント

| Endpoint | Status | Notes |
|----------|--------|-------|
| GET /healthz | 200 OK | `{"status":"ok","version":"0.1.0"}` |
| GET /api/setup-status | 200 OK | `{"setupComplete":true}` |
| GET /api/incidents | 200 OK | 15 items, pagination 対応 |
| GET /api/incidents/:id | 200 OK | 全フィールド存在 |
| GET /api/incidents/:id/evidence | 200 OK | proofCards + surfaces 構造 |
| POST /api/incidents/:id/evidence/query | 401 | session cookie 必須（設計通り） |
| GET /api/runtime-map | 200 OK | nodes=[], edges=[] (SpanBuffer empty) |
| GET /api/services | 200 OK | [] (SpanBuffer empty) |
| GET /api/activity | 200 OK | [] (SpanBuffer empty) |
| GET /api/incidents/:id/telemetry/spans | 200 OK | 大量の spans 返却 |
| GET /api/incidents/:id/telemetry/metrics | 200 OK | metrics 配列 |
| GET /api/incidents/:id/telemetry/logs | 200 OK | correlated + contextual 構造 |
| POST /api/chat/:id | — | session cookie 必須、UI テスト未実施 |

### A-6. Diagnosis Result (ADR 0019)

| 必須フィールド | 実装状態 | 判定 |
|--------------|---------|------|
| summary (headline) | "validation-web began receiving HTTP 429..." | **OK** |
| recommendation.immediate_action | 4ステップの具体的アクション | **OK** |
| recommendation.action_rationale_short | "Retrying against a rate-limited dependency..." | **OK** |
| recommendation.do_not | "Do NOT increase worker pool size..." | **OK** |
| reasoning.causal_chain | 5ステップ: External Trigger→Design Gap→Design Gap→Cascade→User Impact | **OK** |
| operator_guidance (checks) | 8項目の具体的チェックリスト | **OK** |
| confidence | 85%, High confidence | **OK** |
| root_cause_hypothesis | "Stripe rate-limited validation-web..." | **OK** |

### A-7. 発見された技術的問題

| # | 重大度 | 問題 | 詳細 |
|---|--------|------|------|
| B-1 | CRITICAL | Evidence タブが Incident Board に遮蔽される | `document.elementFromPoint()` がタブ座標で `<strong>Why:</strong>` を返す。Z-index/overflow の問題 |
| B-2 | MEDIUM | Runtime Dependency Map が常に空 | SpanBuffer in-memory + cold start でリセット |
| B-3 | MEDIUM | Metrics 表示がチャートではなくテーブル | figma-brief は "real timeseries charts" 要求 |
| B-4 | LOW | Q&A で "Diagnosis narrative is not attached" | narrative 未接続 |
| B-5 | LOW | 保持期間制限が未実装 | 6日前の incident が残存（定義は最大3日） |
| B-6 | INFO | 古い incident に headline がない | diagnosis 未到達で空文字列 |

### スクリーンショット一覧

| # | ファイル | 内容 |
|---|---------|------|
| 1 | 01-landing.png | Auth token 入力画面 |
| 2 | 02-normal-mode.png | Normal mode (Map view) — summary stats + incident list |
| 3 | 03-incident-board-full.png | Incident Board — 全セクション表示 |
| 4 | 05-evidence-metrics-url.png | Evidence Studio Metrics タブ (URL 遷移) |
| 5 | 06-evidence-logs.png | Evidence Studio Logs タブ |
| 6 | 07-incident-no-diagnosis.png | Diagnosis unavailable 状態 |
