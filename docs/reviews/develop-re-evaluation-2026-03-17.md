# Develop Re-evaluation — 2026-03-17

- Target: `origin/develop` (`7cea8ad`)
- Reviewer: **Claude Opus 4.6** (3-agent parallel audit + synthesis)
- Prior review: `develop-full-audit-2026-03-16.md` (`a390975`)
- Delta: 14 commits, 8 PRs merged (#89–#96), +9,862/-1,942 lines, 84 files
- Scope: Full re-evaluation — backend, frontend, architecture, diagnosis, production readiness

---

## Executive Summary

前回レビュー (03-16 PM) 以降、TelemetryStore 統一設計 (ADR 0032) とトレースベース cross-service incident formation (ADR 0033) が実装された。これは **backend アーキテクチャの最も重要な構造的改善** であり、rawState 無制限成長 (B-1) と span 重複 (B-8) を根本的に解消した。テスト数は 627 → 850 (+35.6%)。ビルドは完全 GREEN。

一方で、**frontend は前回から変更なし** — prior review の a11y 全項目、dead CSS、EvidenceStudio のレイアウト問題、TopBar の severity ハードコード等が全て未着手。新たな監査で **EvidenceStudio が document flow 内にレンダリングされている** (position:fixed/portal なし) という設計上の重大問題を発見。

**プロダクト価値の観点では、TelemetryStore/trace formation は「より良い基盤」であり、ユーザーが体感する改善ではない。** 診断スコアの再計測、platform deploy、operator 体験の検証はいずれも未実施。

---

## ビルド健全性


| チェック      | 03-16 PM (`a390975`) | 03-17 (`7cea8ad`)         |
| --------- | -------------------- | ------------------------- |
| typecheck | GREEN (0 errors)     | **GREEN** (0 errors) ✅    |
| build     | GREEN (5/5)          | **GREEN** (5/5) ✅         |
| test      | 627 passed           | **850 passed** (+35.6%) ✅ |
| lint      | GREEN                | **GREEN** ✅               |


テスト増分 +223 は主に TelemetryStore と formation テスト群。

---

## 1. Backend (Receiver + Core)

### 構造的改善 (ADR 0032 / 0033)

**TelemetryStore (ADR 0032) — 実装完了:**

- rawState を `telemetryScope` + `spanMembership` + `anomalousSignals` に分解
- `spanMembership` に `MAX_SPAN_MEMBERSHIP=5000` の上限あり
- span deduplication: TelemetryStore は UPSERT (traceId+spanId unique) で重複排除
- lazy-migration: 既存 rawState 行は読み取り時に新カラムに変換

**Trace-based formation (ADR 0033) — 実装完了:**

- `getIncidentBoundTraceIds()` で既存 incident の spanMembership から traceId 集合を取得
- 同一 traceId を持つ異常スパンは同一 incident に統合 (cross-service)
- `MAX_CROSS_SERVICE_MERGE=3` (provisional)

### Prior issue 解消状況


| ID   | Issue                   | 03-16 PM     | 03-17                                                   |
| ---- | ----------------------- | ------------ | ------------------------------------------------------- |
| B-1  | rawState 無制限成長          | **CRITICAL** | **RESOLVED** — TelemetryStore に置換。spanMembership capped |
| B-5  | rebuildPacket 空 spans   | OPEN         | **RESOLVED** — TelemetryStore 経由で spans 取得              |
| B-8  | span deduplication なし   | OPEN         | **RESOLVED** — UPSERT で重複排除                             |
| B-2  | 単一共有 Bearer token       | OPEN         | **OPEN**                                                |
| B-3  | listIncidents limit:100 | PARTIAL      | **PARTIAL** — platform-events のみ paginated              |
| B-7  | chat timeout なし         | OPEN         | **OPEN**                                                |
| B-10 | 構造化ログなし                 | OPEN         | **OPEN**                                                |


### 新規発見事項


| ID   | 重要度        | 内容                                                                                                                                                |
| ---- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-11 | **HIGH**   | `**POST /api/chat/:id` が認証不要。** rate limiting もなし。incident ID を知る任意のクライアントが無制限に LLM リクエスト可能 → Anthropic API コスト暴走                                 |
| B-12 | **HIGH**   | `**anomalousSignals` 配列に上限なし。** `spanMembership` は 5000 cap だが anomalousSignals は無制限。長期 incident で JSON 肥大化                                       |
| B-13 | **MEDIUM** | **API router (`/api/`*) に bodyLimit なし。** ingest router は 1MB だが、`/api/diagnosis/:id` と `/api/chat/:id` は無制限                                      |
| B-14 | **MEDIUM** | **chat history の per-turn content length 未検証。** history.length (10) と message.length (500) は検証するが、各 history turn の content は無制限                   |
| B-15 | **MEDIUM** | **DB 読み取り時に Zod re-validation なし。** `PostgresAdapter.toIncident()` が `row.packet as IncidentPacket` で直接キャスト。schema evolution 時に silent corruption |
| B-16 | **MEDIUM** | **2 つの DB connection pool** が同一 URL に対して開かれる (PostgresAdapter + PostgresTelemetryAdapter、各 max:10)。Vercel Postgres の接続数制限に抵触するリスク                 |
| B-17 | **LOW**    | `anomaly-detector.ts` と `formation.ts` に `normalizeDependency` が重複定義。前者は localhost フィルタなし                                                         |
| B-18 | **LOW**    | 空文字 traceId/spanId が membership に混入する可能性                                                                                                          |


---

## 2. Diagnosis Engine + CLI

### ADR 0019 v2 準拠


| 要件                                          | 状態                                                     |
| ------------------------------------------- | ------------------------------------------------------ |
| callModel: 120s timeout                     | ✅                                                      |
| callModel: max 2 retry                      | ✅ (SDK 委任)                                             |
| callModel: retry 429/529 only               | ⚠️ SDK が 408/409/5xx も retry (実用上無害)                   |
| parseResult: causal_chain ≤ 8               | ✅                                                      |
| parseResult: strings ≤ 2,000 / detail ≤ 500 | ✅                                                      |
| buildPrompt: details 1,000 char truncation  | ✅                                                      |
| CLI callback retry                          | ✅                                                      |
| **prompt evidence cap (PR #89)**            | ✅ **NEW** — metrics/logs/traceRefs の token overflow 防止 |


### 未解決


| ID  | 重要度        | 内容                                                                                                |
| --- | ---------- | ------------------------------------------------------------------------------------------------- |
| D-1 | **MEDIUM** | `**signalSeverity` がプロンプトに含まれない。** packetizer で計算されるが buildPrompt が drop。LLM が severity を見れない     |
| D-4 | **LOW**    | `**peerService` がプロンプトの trace 行に含まれない。** scope.affectedDependencies 経由では間接的に到達するが per-span では見えない |


---

## 3. Console Frontend

### 変更なし (03-16 PM → 03-17)

**apps/console/ に差分ゼロ。** 前回レビューの全指摘が未着手のまま残存。

### 新規発見事項 (deeper audit)


| ID  | 重要度        | 内容                                                                                                                                                                  |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N-1 | **HIGH**   | **EvidenceStudio が document flow 内にレンダリング。** `.es-app` に `position: fixed` も `createPortal()` もなく、scroll container 内の通常要素として描画。full-viewport overlay の設計意図が実現されていない |
| N-2 | **HIGH**   | **TopBar の severity badge が "Critical" にハードコード。** `incident.packet.signalSeverity` を無視                                                                              |
| N-3 | **MEDIUM** | **TracesView の CSS/DOM クラス不一致。** JSX は `tg-id`, `tg-dur`, `tg-count` を使用、CSS は `tg-meta`, `tg-stats`, `tg-duration` 等を定義 → スタイル適用なし                                 |
| N-4 | **MEDIUM** | **MetricsView の `chart-container` が SVG にも適用。** border/padding/overflow:hidden が SVG に伝播                                                                            |
| N-5 | **MEDIUM** | `**@keyframes pulse-glow` が重複定義** (animations.css vs evidence-studio.css、値が異なる)                                                                                     |
| N-6 | **MEDIUM** | **shell.css/board.css に raw `rgba()` 値が散在。** token (`var(--accent-soft)` 等) を使用していない                                                                                |


### Prior items 未解決一覧 (全て OPEN)

**P0 (a11y):** F-2 (div の keyboard access), F-3 (ARIA tablist), F-4 (focus-visible), F-5 (focus trap)
**P1 (機能):** F-6 (tab state loss), F-7 (scroll-to-target dead code), F-14 (MetricsView 単一 chart), F-15 (LogsView expandedIdx)
**P2 (cleanup):** U-14 (QueryClient defaults), U-16/F-9 (Geist font), F-11 (MitigationWatch dead code), F-12 (dead CSS), F-10/U-17 (radius 不整合)

---

## 4. Architecture + ADR

### ADR ステータス


| ADR       | Status              | 備考        |
| --------- | ------------------- | --------- |
| 0001–0029 | Accepted/Superseded | 正常        |
| 0030      | Superseded by 0032  | ✅         |
| **0031**  | **Proposed**        | 実装済みだが未承認 |
| **0032**  | **Proposed**        | 実装完了だが未承認 |
| **0033**  | **Proposed**        | 実装完了だが未承認 |


**ADR 0031/0032/0033 が Proposed のまま実装されている。** プロジェクトの `feedback_adr_approval.md` ルール（ADR は承認を得てから実装）に違反。

### ADR 実装準拠

31 ADR 中、主要 ADR (0016–0033) は概ね COMPLIANT。Drift は以下のみ:

- ADR 0019 v2: retry policy が SDK 委任 (minor)
- ADR 0017: 48h auto-close 未実装 (deferred)

### Production Readiness


| 項目                                          | 状態                  |
| ------------------------------------------- | ------------------- |
| `receiver:bundle`                           | ❌ `echo 'TODO'` のまま |
| Deploy config (vercel.json / wrangler.toml) | ✅ vercel.json + vercel-entry.ts (V-2) |
| Health check endpoint                       | ✅ `/healthz` (V-2 で検証済み) |
| Security headers (CSP/X-Frame-Options)      | ✅ (P2 で実装済み)        |
| Rate limiting                               | ❌ なし                |
| 構造化ログ                                       | ❌ なし                |
| 48h auto-close                              | ❌ deferred          |
| `--frozen-lockfile` in CI                   | ❌ なし                |


**全て前回と同一。Production readiness に進展なし。**

---

## 5. Security


| 領域                                       | 状態                     |
| ---------------------------------------- | ---------------------- |
| Auth (Bearer Token) fail-closed          | ✅                      |
| CORS 3-mode                              | ✅                      |
| Zod `.strict()` 全階層                      | ✅                      |
| OTLP body limit + zip bomb 防御            | ✅                      |
| SQL injection (Drizzle parameterized)    | ✅                      |
| Prompt injection (details truncation)    | ⚠️ Phase 1 許容          |
| `**/api/chat/:id` 認証なし + rate limit なし** | ❌ **最重要 security gap** |
| **API router bodyLimit なし**              | ❌                      |
| **CSP headers**                          | ❌                      |
| **Chat history per-turn content 無制限**    | ❌                      |


---

## スコアリング


| 次元                   | 03-14 (Codex) | 03-14 (Opus) | 03-16 AM | 03-16 PM | **03-17** | 変化                     |
| -------------------- | ------------- | ------------ | -------- | -------- | --------- | ---------------------- |
| Architecture         | A             | A            | A        | A        | **A**     | →                      |
| Backend code         | —             | B+           | A-       | A-       | **A**     | ↗ TelemetryStore で構造改善 |
| Frontend code        | —             | B            | C+       | B        | **B-**    | ↘ 新規発見 (N-1, N-2, N-3) |
| Console UX           | B             | B            | D+       | B-       | **B-**    | → 変更なし                 |
| Test quality         | —             | B+           | A-       | A-       | **A**     | ↗ 850 tests            |
| Packet model         | —             | C+           | B+       | B+       | **A-**    | ↗ TelemetryStore 統合    |
| Security             | —             | B            | B        | B        | **B-**    | ↘ chat 認証なし再認識         |
| Diagnosis            | —             | B            | B        | B+       | **B+**    | → evidence cap 追加      |
| Evidence Studio      | —             | —            | —        | B        | **B-**    | ↘ N-1 (layout bug) 発見  |
| Production readiness | —             | —            | —        | D        | **D**     | → 進展なし                 |
| Process quality      | —             | A-           | A        | A        | **A-**    | ↘ ADR 承認前実装            |
| **Overall**          | **B+**        | **B+**       | **B**    | **B+**   | **B+**    | →                      |


---

## 評価の推移グラフ

```
Overall:  B+ → B+ → B  → B+ → B+
          03-14  03-14  03-16  03-16  03-17
          Codex  Opus   AM     PM     ←今回
```

**B+ 維持。** backend の構造的改善 (A- → A) と test 充実 (A) が、frontend 新規発見 (N-1〜N-6) と production readiness 停滞 (D) を相殺。

---

## 優先度整理

### P0 — 運用に必要 (セキュリティ)


| #   | 課題                                       | 理由                                    |
| --- | ---------------------------------------- | ------------------------------------- |
| 1   | `/api/chat/:id` に認証 or rate limit (B-11) | unauthenticated LLM proxy → API コスト暴走 |
| 2   | `anomalousSignals` 上限追加 (B-12)           | spanMembership は capped だがこちらは未 cap   |


### P1 — Frontend 構造修正


| #   | 課題                                    | 理由                              |
| --- | ------------------------------------- | ------------------------------- |
| 3   | EvidenceStudio を fixed/portal に (N-1) | full-viewport overlay の設計意図が未実現 |
| 4   | TopBar severity 動的化 (N-2)             | 常に "Critical" 表示はバグ             |
| 5   | TracesView CSS/DOM 整合 (N-3)           | span 行にスタイルが当たっていない             |


### P2 — Production deploy 前提条件


| #   | 課題                              | 理由                |
| --- | ------------------------------- | ----------------- |
| 6   | `receiver:bundle` 実装            | deploy 不可         |
| 7   | Security headers                | 基本的な web security |
| 8   | Health check endpoint           | LB/monitoring     |
| 9   | API router bodyLimit (B-13)     | DoS 防止            |
| 10  | ADR 0031/0032/0033 を Accepted に | 承認前実装の状態解消        |


### P3 — 品質・a11y


| #   | 課題                             | 理由                        |
| --- | ------------------------------ | ------------------------- |
| 11  | a11y 一括修正 (F-2/3/4/5)          | keyboard/screen reader 対応 |
| 12  | `signalSeverity` をプロンプトに (D-1) | 診断品質向上                    |
| 13  | Dead CSS/code 整理               | 保守性                       |
| 14  | Geist font 除去 (F-9)            | 不要バンドル                    |


### P-validation — プロダクト価値検証


| #   | 課題                    | 理由                                           |
| --- | --------------------- | -------------------------------------------- |
| V-1 | ~~全5シナリオ再実行~~ **DONE** | **7.4 → 7.8/8 改善確認。** シナリオ2: 5/8→8/8 (ADR 0033)、シナリオ3: 5/8→7/8 |
| V-2 | ~~Vercel に1回デプロイ~~ **DONE** | **E2E 動作確認、8/8 診断スコア。** 課題: LLM 発火タイミング (V2-1) |
| V-3 | **operator 30秒体験の検証** | プロダクト定義の充足確認                                 |


---

## 結論

**Backend は着実に成熟しつつある。** TelemetryStore (ADR 0032) は rawState の構造的欠陥を根本解決し、trace-based formation (ADR 0033) は cross-service incident detection を実現した。テスト数 850 はフェーズ1としては十分に厚い。

**V-1 (全 5 シナリオ再実行) を 03-17 中に完了。** TelemetryStore + trace formation の改善がユーザー価値 (診断品質) に直結することを Railway staging で実証した。

残る懸念は platform deploy (V-2) と operator 30 秒体験 (V-3) が未検証であること。

---

## V-1: 全 5 シナリオ診断スコア再計測 (Railway staging)

- 環境: Railway staging (PostgresTelemetryAdapter, full scoring pipeline)
- モデル: Claude Sonnet 4.6 via Max plan (手動診断)
- プロンプト: v5 (7-step SRE investigation)

| # | シナリオ | 03-07 (local) | **03-17 (Railway)** | 差分 |
|---|---------|:---:|:---:|:---:|
| 1 | third_party_api_rate_limit_cascade | 8/8 | **8/8** | ± 0 |
| 2 | cascading_timeout_downstream_dependency | 8/8 * | **8/8** | ± 0 ** |
| 3 | db_migration_lock_contention | 5/8 | **7/8** | +2 |
| 4 | secrets_rotation_partial_propagation | 8/8 | **8/8** | ± 0 |
| 5 | upstream_cdn_stale_cache_poison | 8/8 | **8/8** | ± 0 |
| | **平均** | **7.4/8 (≈9.2/10)** | **7.8/8 (≈9.7/10)** | **+0.4** |

\* 03-07 はローカル fixture passthrough (全データ入り)。Railway receiver 経由では ADR 0033 修正前に 5/8 だった。
\*\* Railway 経由で初めて 8/8。trace-based cross-service merge (ADR 0033) の効果。

### シナリオ 2 (cascading_timeout) — 改善の根拠

| | ADR 0033 前 (Railway) | ADR 0033 後 (Railway) |
|---|---|---|
| affectedServices | `["unknown_service:node"]` | `["mock-notification-svc", "validation-web", "unknown_service:node"]` |
| Root cause | notification-svc 単体の問題 | notification → web worker pool → checkout cascade |
| Score | 5/8 | **8/8** |

### シナリオ 3 (db_migration) — 残存課題

-1 は causal chain で Stripe を affected dependency として誤認。`payment_429_total` metric が前回 run の frozen cumulative counter を保持しており、OTel cumulative counter の reset semantics が receiver で未処理。**packet の問題**。

### 発見された構造的課題

1. **LLM 診断キックのタイミング**: generation=1 の初期 packet で即座にキックされるが evidence が薄い。quiet period debounce (60s) の実装が必要
2. **Cumulative counter の reset semantics**: OTel counter restart で値がリセットされないため、前回 run の値が red herring になる
3. **正常データの evidence 包含**: anomaly-triggered formation の構造上、正常サービスのデータは incident に入らない。Phase 1 では LLM 推論に任せて許容

---

**「基盤改善がユーザー価値に届いているか」の問いに対して、V-1 で肯定的な回答が得られた。** TelemetryStore の evidence scoring と trace-based formation は、Railway staging の end-to-end パイプラインで 7.4 → 7.8/8 の改善として実測された。特にシナリオ 2 の 5/8 → 8/8 は formation 修正の直接的な効果であり、「内部データモデルの改善がユーザーに届く」ことを示している。

残る ~~V-2 (Vercel deploy)~~ と V-3 (operator 30 秒体験) は引き続き未検証。

---

## V-2: Vercel Deploy E2E 検証 (2026-03-18)

- 環境: Vercel Hobby (free) + Neon Free (PostgreSQL)
- URL: `https://3amoncall.vercel.app`
- モデル: Claude Sonnet 4.6 (GitHub Actions workflow_dispatch)
- プロンプト: v5 (7-step SRE investigation)

### 検証結果

| チェック項目 | 結果 |
|---|---|
| `GET /healthz` → 200 | ✅ `{"status":"ok","version":"0.1.0"}` |
| OTel ingest (`POST /v1/traces`) | ✅ incident 作成、generation=36 |
| `GET /api/incidents` | ✅ incident 一覧取得 |
| `GET /api/services` | ✅ SpanBuffer 動作 (warm instance) |
| Neon テーブル自動作成 | ✅ cold start で migrate 実行 |
| thin event → GitHub Actions dispatch | ✅ `dispatchThinEvent` → workflow_dispatch |
| LLM 診断 (GitHub Actions) | ✅ Sonnet 4.6, 45s |
| callback → Receiver 保存 | ✅ `POST /api/diagnosis/:id` → 200 |
| Console SPA | ✅ static 配信 |
| `make vercel` (validation scenario) | ✅ end-to-end 動作 |

### 診断スコア (シナリオ 1: third_party_api_rate_limit_cascade)

| 軸 | スコア |
|---|---|
| Immediate action effectiveness | 2/2 |
| Root cause accuracy | 2/2 |
| Causal chain coherence | 2/2 |
| Absence of dangerous suggestions | 2/2 |
| **合計** | **8/8** |

Packet evidence: changedMetrics=10, representativeTraces=4, relevantLogs=2, triggerSignals=4。全データが正常に蓄積されていた。

### 発見された課題

| # | 重要度 | 内容 |
|---|---|---|
| V2-1 | **HIGH** | **LLM 診断の発火タイミングに設計上の保証なし。** debouncer は in-memory timer で serverless では動作しないため `DIAGNOSIS_GENERATION_THRESHOLD=0`, `DIAGNOSIS_MAX_WAIT_MS=0` で無効化。thin event は generation 1 (インシデント作成直後) で即発火する。今回は GitHub Actions の cold start (checkout + install + build = 4〜5分) の間に OTel batch が 35 回到着し、packet fetch 時点で generation 36 の full-data が取得できたが、これは偶然。Actions が高速化した場合、不完全なデータで診断が走るリスクがある。 |

### V2-1 の対策案 (未実施)

serverless 環境では in-memory debouncer が使えないため、platform-native な遅延メカニズムが必要:
- **Vercel**: Cron Job (1分間隔) で未診断インシデントをポーリング → generation が安定 (N秒変化なし) したら dispatch
- **Cloudflare**: Durable Objects + Alarms
- **共通**: GitHub Actions 側に wait step 追加 (e.g., 60s sleep before packet fetch)

最も低コストな暫定策は Actions の `sleep 60` で、platform 側の変更不要。

---

*Reviewed by Claude Opus 4.6 (3-agent parallel audit + synthesis) — 2026-03-17*
*V-1 diagnosis re-evaluation by Claude Sonnet 4.6 via Max plan (manual, Railway staging) — 2026-03-17*
*V-2 Vercel deploy verification — 2026-03-18*