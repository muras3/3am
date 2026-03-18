# ADR 0032: TelemetryStore — 統一 OTel データストレージと Evidence 選別アルゴリズム

- Status: Accepted
- Date: 2026-03-17
- Supersedes: ADR 0030 (Incident State and Packet Rebuild)
- Amends: ADR 0029 (Ambient Read Model), ADR 0031 (Platform Event Contract)

## Context

OTel 生データの管理が 2 つの仕組みに分裂している:

- **SpanBuffer** (in-memory ring buffer, max 1000, TTL 5min) — normal mode の services/activity API 用 (ADR 0029)
- **rawState** (DB JSONB, incident 従属) — Evidence Studio 表示 + packet 生成素材 (ADR 0030)

この分裂が引き起こしている問題:

1. **rawState の無制限膨張**: incident ごとに JSONB で生データを accumulate。dedup も selection もなく、token overflow の直接原因 (PR #89 の応急処置)
2. **Packetizer の選別アルゴリズム不在**: traces は 2-stage scoring (scoreSpan + diversity fill → 10 件) があるが、metrics/logs は raw passthrough。packetizer が要約の責務を果たしていない
3. **Packet の設計意図との乖離**: ADR 0016/0018 は packet を evidence-primary + pointers で設計したが、実装では evidence にデータ本体をコピーし pointers の存在意義が死んでいる
4. **データの二重管理**: SpanBuffer と rawState で同一の span データを別々に保持

### 研究知見

学術論文 (RCACopilot, HolmesGPT, OpenRCA 等) と商用プラットフォーム (Datadog Watchdog, Grafana Sift, Honeycomb BubbleUp) の consensus は **3 層パイプライン**:

```
Layer 1: Collect     — OTel ingest → raw data storage
Layer 2: Score & Select — anomaly scoring → ranking → diversity fill → bounded output
Layer 3: Format for LLM — token budget management → prompt construction
```

3amoncall は Layer 2 の metrics/logs 選別が未実装。PR #89 の buildPrompt 側 cap は Layer 3 での応急処置であり、間違った層で対処している。

詳細: [docs/research/telemetry-evidence-selection-2026-03.md](../research/telemetry-evidence-selection-2026-03.md)

## Decision

### 1. TelemetryStore — incident 非依存の独立ストア

OTel 生データを incident に紐づけず、独立したストアとして保持する。

```
OTel ingest → TelemetryStore（単一の生データストレージ）
                ├→ normal mode: services / activity クエリ (via SpanBuffer L1)
                ├→ incident 検知: anomaly detection
                ├→ Evidence Studio: 生データ閲覧
                └→ packetizer: 選別アルゴリズム → incident packet
```

rawState (ADR 0030) は廃止する。TelemetryStore が OTel 生データの single source of truth になる。

### 2. SpanBuffer を L1 cache として残す

SpanBuffer (ADR 0029) は normal mode の低遅延クエリ用 L1 cache として維持する。

```
OTel ingest → SpanBuffer (L1: in-memory, max 1000, TTL 5min)
            → TelemetryStore (L2: platform DB, 48h retention)
```

- SpanBuffer は ADR 0029 の仕様をそのまま維持（容量、TTL、push タイミング、集計方式）
- `/api/services` と `/api/activity` は引き続き SpanBuffer から計算
- TelemetryStore は Evidence Studio、packetizer、baseline 計算に使用

**ADR 0029 への影響**: SpanBuffer のスコープを「ambient read model の L1 cache」に narrow する。ADR 0029 の「永続化は非目標」は SpanBuffer に限定した記述として維持。TelemetryStore は別の永続化レイヤー。

### 3. Drizzle ORM + cross-platform adapter、type 別テーブル

TelemetryStore は StorageDriver (ADR 0013) とは別の subsystem だが、**同じ cross-platform adapter パターン**を採用する。ADR 0013 の「CF Workers と Vercel の両対応」は製品方針であり、TelemetryStore もこれに従う。

```
apps/receiver/src/
  storage/          ← StorageDriver (incident canonical store) — 既存
  telemetry/        ← TelemetryStore (OTel raw data store) — 新規
    interface.ts    ← TelemetryStoreDriver interface
    adapters/
      vercel.ts     ← Vercel Postgres adapter (Drizzle)
      cloudflare.ts ← CF D1 adapter (Drizzle)
      memory.ts     ← In-memory adapter (dev/test)
```

テーブル構成:

| テーブル | 主な列 | インデックス |
|---------|--------|------------|
| `telemetry_spans` | traceId, spanId, serviceName, environment, durationMs, httpStatusCode, spanStatusCode, peerService, ingestedAt, ... | (serviceName, ingestedAt), (traceId, spanId) UNIQUE |
| `telemetry_metrics` | service, environment, name, startTimeMs, summary (JSONB/TEXT), ingestedAt | (service, name, startTimeMs) UNIQUE, (ingestedAt) |
| `telemetry_logs` | service, environment, timestamp, severity, body, bodyHash, attributes (JSONB/TEXT), traceId, spanId, ingestedAt | (service, timestamp, bodyHash) UNIQUE, (ingestedAt), (traceId) |

Drizzle ORM を使用 (ADR 0024 と同じ技術選定)。StorageDriver schema の peer であり、StorageDriver interface には含めない。

**CF D1 (SQLite) での考慮事項**:
- JSONB → TEXT (JSON string) で代替。Drizzle の `text("json")` mode で吸収
- z-score baseline 計算は DB 集計関数ではなくアプリケーション側で実行（SQLite の集計関数制約を回避）
- 48h TTL の cleanup は同じ `DELETE WHERE ingestedAt < ?` で動作

### 4. 48h retention + curated snapshot

#### Retention

TelemetryStore のデータは **48 時間** で TTL 削除する。

- 定期的な cleanup job で `ingestedAt < NOW() - 48h` のレコードを削除
- 48h の根拠: 「昨日の夜中に何か起きてた」を翌朝調べられる運用ユースケース
- 長期保存は non-goal

#### Curated Snapshot

Packetizer が選別した結果を **別テーブル** (`incident_evidence_snapshots`) に保存する。Snapshot は incident 作成時だけでなく、**新しい evidence が TelemetryStore に到着するたびに再構築**される。

```
incident_evidence_snapshots:
  incidentId (FK → incidents)
  snapshotType: "traces" | "metrics" | "logs" | "platform_events"  # see Appendix A.2: platform_events deferred
  data (JSONB)
  updatedAt
```

- Snapshot は packet rebuild の入力 — ADR 0030 の rawState の役割を引き継ぐが、**raw accumulation ではなく選別済みの結果**を保持する点が異なる
- Rebuild trigger: incident の time window に該当する新しい spans/metrics/logs/platform events が ingest されるたびに、packetizer が TelemetryStore から再選別 → snapshot を UPSERT → packet を rebuild
- Packet は ADR 0018 の通り **derived current-state view** を維持。snapshot の更新が packet の rebuild を駆動する
- TelemetryStore の 48h TTL 後もスナップショットは incident が存在する限り保持（48h 後は snapshot が唯一の evidence 記録になる）
- Incident close + retention 超過で snapshot も削除

### 5. Metrics / Logs 選別アルゴリズム (Scoring + Diversity Fill)

Traces の既存パターン (scoreSpan + diversity fill) を metrics/logs に拡張する。

#### 5.1 Metrics Scoring

```
score = z_score(baseline, incident_value)     # baseline 比の異常度
      × metric_class_weight                    # metric 種別の重み
      + span_temporal_correlation_bonus         # anomalous spans との Spearman 相関
```

**z-score baseline**:
- Baseline window: incident window の **4 倍**の長さ (Netdata 方式)
- `z_score = (incident_value - baseline_mean) / baseline_stddev`
- |z| >= 3 で anomaly フラグ (Booking.com 実績)

**Cold start / baseline 不足時の fallback**:
- TelemetryStore に十分な baseline データがない場合、volume heuristic (percentage change) にフォールバック
- baseline データ不足の判定: baseline window 内の datapoint が 3 未満

**Metric class weight** (OTel semantic conventions ベース):
| クラス | 重み | 例 |
|--------|:----:|-----|
| Error rate | 1.0 | http.server.request.error_rate |
| Latency | 0.8 | http.server.request.duration |
| Throughput | 0.6 | http.server.request.count |
| Resource | 0.4 | process.runtime.memory, db.pool.connections |

**Spearman 相関** (HeMiRCA):
- anomalousSignals の時間分布と metric datapoint の時間分布の Spearman 相関係数を計算
- 相関係数が高い metric に bonus 加点
- 計算可能な場合のみ (十分な datapoint が必要)

#### 5.2 Logs Scoring

```
score = severity_weight
      × temporal_proximity          # e^(-λ × Δt), detect 時刻基準
      × (1 + log₂(count))          # dedup 後のグループ件数
      + trace_correlation_bonus     # anomalous span と同じ trace_id なら加点
      + keyword_bonus               # diagnostic keyword 検出で加点
```

**Pipeline**:

1. **Parse**: regex 正規化 (数値→`<NUM>`, UUID→`<UUID>`, IP→`<IP>`) → fingerprint hash
2. **Dedup**: fingerprint でグループ化。グループごとに count + 代表ログを保持
3. **Score**: 上記 formula で各グループをスコアリング
4. **Select**: top-N グループ by score。各グループから代表 1 件
5. **Diversity**: サービス多様性を確保 (trace と同じ per-service cap パターン)

**Severity weight** (OTel SeverityNumber):
| Severity | Weight |
|----------|:------:|
| FATAL (21-24) | 3.0 |
| ERROR (17-20) | 2.0 |
| WARN (13-16) | 1.0 |

**Temporal proximity**: `weight = e^(-λ × Δt)` where Δt = |log.timestamp - incident.detect|。detect 直前のログほど高スコア。

**Trace correlation bonus**: ログの `traceId` / `spanId` が anomalous span と一致する場合に加点。OTel の signal correlation を活用。

**Keyword bonus**: body に diagnostic keyword (timeout, connection refused, rate limit, OOM, circuit breaker, deadline exceeded, pool exhausted) を含む場合に加点。

#### 5.3 Diversity Fill (共通パターン)

Metrics / Logs とも、trace の既存 diversity fill パターンを踏襲:

1. Score 降順ソート
2. Top guarantee: 最高スコア N 件を確保 (置換不可)
3. Service diversity pass: 未出現サービスから最高スコアを優先選択
4. Fallback pass: 未出現サービスがなければ任意から最高スコアを選択

### 6. Packet 出力サイズ contract

Packetizer が packet に含める各セクションの最大件数:

| セクション | MAX | Token 見積り |
|-----------|:---:|:----------:|
| `evidence.representativeTraces` | **10** | ~600 |
| `evidence.changedMetrics` | **15** | ~1,500 |
| `evidence.relevantLogs` | **20** | ~3,000 |
| `pointers.traceRefs` | **30** | ~300 |

合計 evidence: ~5,400 tokens。Sonnet 4.6 入力 200K のうち prompt template + 出力予約を差し引いた ~50K tokens の evidence 枠に対して十分な余裕がある。

これらは **チューニング可能な定数** として実装し、validation シナリオでの実測結果に基づいて調整する。

選別アルゴリズムが入ることで、現行の無選別 cap (PR #89) より少ない件数でも情報量は増える:
- RCACopilot: 診断データを 120-140 words に要約して精度 +7.7% 向上
- 研究の consensus: noise 削減 > 量の確保

buildPrompt 側の応急 cap (MAX_METRICS=20, MAX_LOGS=30, MAX_TRACE_REFS=20) は、packetizer 側選別の実装完了後に safety net として残すか削除するかを判断する。

### 7. Evidence Studio — TelemetryStore 直接クエリ

Evidence Studio は TelemetryStore を直接クエリして生データを表示する。

- Incident の time window + affected services で TelemetryStore を検索
- Curated snapshot (Decision 4) は packetizer 用であり、Evidence Studio の入力ではない
- Evidence Studio の目的は**生データ探索**であり、選別前の全データにアクセスできる必要がある
- 48h retention 内であれば全データが閲覧可能

**ADR 0025 との整合**: TelemetryStore のクエリが Evidence Studio のレスポンス遅延のボトルネックにならないよう、Decision 3 のインデックス設計で対応する。

### 8. Ingest 時の dedup / cap 戦略

TelemetryStore への書き込み時は **UPSERT dedup のみ**。Sampling や volume cap は設けない。

| データ種別 | Dedup key | 方式 |
|-----------|-----------|------|
| Spans | `(traceId, spanId)` | UPSERT |
| Metrics | `(service, name, startTimeMs)` | UPSERT |
| Logs | `(service, timestamp, bodyHash)` | UPSERT |

- Sampling しない理由: 正常データも baseline 計算 (z-score) に必要。間引くと異常検知の精度が落ちる
- Volume cap を設けない理由: 48h TTL で自然消滅。ターゲットユーザーは小規模チームであり、爆発的ボリュームは想定しにくい
- Volume cap は実運用で問題が出てから追加する

## 既存 ADR との関係

### Supersedes: ADR 0030 (Incident State and Packet Rebuild)

ADR 0030 の rawState (incident-scoped JSONB) は TelemetryStore + curated snapshot に置き換える。

| ADR 0030 の概念 | 本 ADR での代替 |
|----------------|---------------|
| `IncidentRawState` | TelemetryStore (生データ) + `incident_evidence_snapshots` (選別済み snapshot) |
| rawState への append | TelemetryStore への ingest (incident 非依存) |
| rawState からの packet rebuild | TelemetryStore から再選別 → snapshot 更新 → packet rebuild |
| `appendSpans()` / `appendAnomalousSignals()` | TelemetryStore への通常 ingest |
| `appendRawEvidence()` | TelemetryStore への通常 ingest |
| `getRawState()` | TelemetryStore クエリ (time window + services) |

ADR 0030 の以下の概念は維持:
- Packet は derived view (rebuild で再構成)
- packetId は stable identifier
- Generation tracking

### Amends: ADR 0029 (Ambient Read Model)

ADR 0029 のスコープを narrow する:
- SpanBuffer は「ambient read model の L1 cache」として維持
- 「永続化は非目標」は SpanBuffer に限定。TelemetryStore が永続化を担う
- SpanBuffer の仕様 (容量、TTL、push タイミング、集計方式) は変更なし

### Amends: ADR 0031 (Platform Event Contract)

ADR 0031 で「raw state に保存」とされた platform events の保存先を変更:
- Platform events も TelemetryStore に保存 (`telemetry_platform_events` テーブル)
- Incident 作成時の curated snapshot に含める
- ADR 0031 の canonical shape (eventType, timestamp, environment, description 等) は維持

### Compatible: ADR 0013 (Cross-Platform Storage Driver)

StorageDriver interface は変更しない。TelemetryStore は StorageDriver とは別の subsystem だが、ADR 0013 の cross-platform 方針に従い同じ adapter パターンを採用する。
- StorageDriver: incident canonical store (D1 / Vercel Postgres / Memory)
- TelemetryStore: OTel raw data store (D1 / Vercel Postgres / Memory)

### Compatible: ADR 0016/0018 (Incident Packet)

Packet の semantic sections は変更しない。`pointers.traceRefs` 等の pointer は TelemetryStore 上のデータへの参照として機能する (intent は同じ、参照先が rawState → TelemetryStore に変更)。

### Implements: ADR 0008 (Problem Grouping Without LLM)

Decision 5 の scoring + diversity fill は、ADR 0008 が定めた「LLM を使わない決定的 packetization」の原則を metrics/logs に拡張実装するもの。

## Rationale

- **rawState 廃止**: incident-scoped JSONB への生データ accumulation が token overflow、ストレージ膨張、選別アルゴリズム不在の全原因
- **独立ストア**: OTel データは incident より先に存在する。incident formation は OTel データの analysis の結果であり、逆ではない
- **48h retention**: 長期保存は non-goal だが、翌朝の振り返りに必要な最小限の期間
- **Scoring + Diversity Fill**: 研究 consensus (3 層パイプライン) に基づく。trace で実績のある既存パターンの拡張
- **選別件数**: 研究で少数精鋭が raw dump より高精度 (RCACopilot +7.7%)。チューニング可能にして実測で調整

## Consequences

### 即時の影響

- `IncidentRawState` 型と関連する StorageDriver メソッド (`appendSpans`, `appendAnomalousSignals`, `appendRawEvidence`, `getRawState`) は廃止対象
- `Incident` 型から `rawState` フィールドを削除
- Ingest path が TelemetryStore への書き込みを追加 (SpanBuffer への push と並行)
- Packetizer が TelemetryStore からデータを取得し、scoring + diversity fill で選別
- Evidence Studio のデータソースが rawState → TelemetryStore に変更

### 段階的移行

1. TelemetryStore schema + ingest path 実装
2. Metrics/Logs scoring + diversity fill 実装
3. Curated snapshot テーブル + packetizer 連携
4. Evidence Studio のデータソース切り替え
5. rawState 廃止 + 関連 StorageDriver メソッド削除
6. buildPrompt 側の応急 cap の扱いを判断

### CF D1 (SQLite) 対応

TelemetryStore は StorageDriver と同じ cross-platform adapter パターンで CF D1 をサポートする:
- JSONB 列 → TEXT (JSON string) で代替。Drizzle の abstraction layer で吸収
- z-score baseline 計算はアプリケーション側で実行（datapoint を fetch → JS で計算）
- 48h TTL cleanup、UPSERT dedup は SQLite で問題なく動作

## Appendix A: Implementation Design Decisions (2026-03-17)

本セクションは ADR 0032 の実装に先立ち、本文で未指定だった技術的設計判断を確定する。

### A.1 TelemetryStoreDriver インターフェース

TelemetryStore は `apps/receiver/src/telemetry/` 以下に配置し、StorageDriver (ADR 0013) とは独立した subsystem とする。

```typescript
// ── Row Types (DB 列と 1:1) ──────────────────────────────────────────

interface TelemetrySpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  serviceName: string
  environment: string
  spanName: string
  httpRoute?: string
  httpStatusCode?: number
  spanStatusCode: number
  durationMs: number
  startTimeMs: number
  peerService?: string
  exceptionCount: number
  attributes: Record<string, unknown>  // JSONB/TEXT
  ingestedAt: number                   // epoch ms
}

interface TelemetryMetric {
  service: string
  environment: string
  name: string
  startTimeMs: number
  summary: Record<string, unknown>     // JSONB/TEXT
  ingestedAt: number
}

interface TelemetryLog {
  service: string
  environment: string
  timestamp: string                    // ISO string
  startTimeMs: number
  severity: string                     // WARN | ERROR | FATAL
  severityNumber: number
  body: string
  bodyHash: string                     // normalized SHA-256 hex, 16 chars
  attributes: Record<string, unknown>  // JSONB/TEXT
  traceId?: string
  spanId?: string
  ingestedAt: number
}

// ── Query Filter ─────────────────────────────────────────────────────

interface TelemetryQueryFilter {
  startMs: number   // inclusive
  endMs: number     // inclusive
  services?: string[]  // omit = all services
  environment?: string
}

// ── Evidence Snapshot ────────────────────────────────────────────────

type SnapshotType = "traces" | "metrics" | "logs"

interface EvidenceSnapshot {
  incidentId: string
  snapshotType: SnapshotType
  data: unknown    // JSONB: 選別済みの RepresentativeTrace[] | ChangedMetric[] | RelevantLog[]
  updatedAt: string
}

// ── Driver Interface ─────────────────────────────────────────────────

interface TelemetryStoreDriver {
  // Ingest (UPSERT dedup)
  ingestSpans(rows: TelemetrySpan[]): Promise<void>
  ingestMetrics(rows: TelemetryMetric[]): Promise<void>
  ingestLogs(rows: TelemetryLog[]): Promise<void>

  // Query (time window + services)
  querySpans(filter: TelemetryQueryFilter): Promise<TelemetrySpan[]>
  queryMetrics(filter: TelemetryQueryFilter): Promise<TelemetryMetric[]>
  queryLogs(filter: TelemetryQueryFilter): Promise<TelemetryLog[]>

  // Evidence Snapshots (curated selection per incident)
  upsertSnapshot(incidentId: string, type: SnapshotType, data: unknown): Promise<void>
  getSnapshots(incidentId: string): Promise<EvidenceSnapshot[]>
  deleteSnapshots(incidentId: string): Promise<void>

  // TTL cleanup
  deleteExpired(before: Date): Promise<void>
}
```

**Row Type の設計方針**: `TelemetrySpan` / `TelemetryMetric` / `TelemetryLog` は DB 列と 1:1 対応する TelemetryStore 専用型として新規定義する。既存の `ExtractedSpan` (anomaly-detector 内部型) や `ChangedMetric` / `RelevantLog` (core packet 型) とは別の型であり、packetizer が TelemetryStore から取得したデータを packet 形式に変換する責務を持つ。

### A.2 Platform Events — Phase 1 スコープ外

TelemetryStore の Phase 1 実装 (Step 1〜3) では **platform events を対象外**とする。

- `telemetry_platform_events` テーブルは作成しない
- `ingestPlatformEvents()` / `queryPlatformEvents()` は interface に含めない
- `incident_evidence_snapshots.snapshotType` は `"traces" | "metrics" | "logs"` の 3 種のみ
- Platform events は既存の StorageDriver 経由 (`appendPlatformEvents` / `rawState.platformEvents`) のまま維持
- 本文 Decision 4 の `snapshotType: "platform_events"` は Phase 1 では実装しない

Platform events の TelemetryStore 統合は Phase 1 完了後に別途判断する。

### A.3 Snapshot Rebuild Trigger — Ingest 末尾同期実行

Curated snapshot の rebuild は **ingest リクエスト末尾で同期的**に実行する。

```
OTLP ingest request:
  1. Parse OTLP payload
  2. SpanBuffer.push(spans)        ← 既存
  3. TelemetryStore.ingest(spans/metrics/logs)  ← 新規
  4. Anomaly detection → incident creation      ← 既存
  5. For each open incident whose time window overlaps this ingest:
     → packetizer.rebuildSnapshot(incident, telemetryStore)
     → storageDriver.updatePacket()
  6. Return response
```

**方針**:
- Phase 1 のターゲットは小規模チーム。ingest ボリュームは限定的であり、同期 rebuild で latency が問題になる可能性は低い
- UPSERT dedup により rebuild は冪等。同一データの再送で結果が変わらない
- デバウンスは不要（rebuild 自体が SELECT → score → UPSERT の流れであり、毎回最新のフルデータから再選別する）
- Volume が問題になった場合は非同期化を検討するが、Phase 1 ではシンプルさを優先

### A.4 bodyHash — 正規化後 SHA-256

Logs の dedup key `(service, timestamp, bodyHash)` における `bodyHash` の計算方法:

1. **正規化**: log body の可変部分を placeholder に置換
   - UUID (`[0-9a-f]{8}-[0-9a-f]{4}-...`) → `<UUID>`
   - IPv4 (`\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b`) → `<IP>`
   - 数値 (`\b\d+\.?\d*\b`) → `<NUM>`

2. **ハッシュ**: 正規化後の文字列を SHA-256 hex、先頭 16 chars に truncate

```typescript
function normalizeLogBody(body: string): string {
  return body
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<IP>')
    .replace(/\b\d+\.?\d*\b/g, '<NUM>')
}

function computeBodyHash(body: string): string {
  return createHash('sha256').update(normalizeLogBody(body)).digest('hex').slice(0, 16)
}
```

**設計根拠**:
- ADR 0032 Decision 5.2 の log scoring pipeline「Parse: regex 正規化 → fingerprint hash」と同一のロジックを ingest 時 dedup にも使用し、一貫性を確保
- `"Connection refused to 10.0.1.5:5432 after 3000ms"` と `"Connection refused to 10.0.1.6:5432 after 5000ms"` が同一 fingerprint になり、dedup 効率が向上
- 16 chars (64 bits) は log dedup key として十分な衝突耐性を持つ

### A.5 TTL Cleanup — Ingest 時 Opportunistic

48h TTL の cleanup は **ingest リクエスト内で opportunistic に実行**する。

```typescript
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000  // 1 hour
const RETENTION_MS = 48 * 60 * 60 * 1000     // 48 hours
let lastCleanup = 0

async function maybeCleanup(store: TelemetryStoreDriver): Promise<void> {
  const now = Date.now()
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return
  lastCleanup = now
  await store.deleteExpired(new Date(now - RETENTION_MS))
}
```

- in-memory throttle で 1 時間間隔に制限。ingest の度に実行はしない
- 外部 cron 不要。Phase 1 のシンプルさを優先
- Serverless 環境ではコールドスタートで `lastCleanup` がリセットされるが、最悪でもリクエストごとに 1 回 cleanup が走るだけで問題ない（DELETE WHERE は冪等）
- Cleanup 対象は `telemetry_spans` / `telemetry_metrics` / `telemetry_logs` の 3 テーブル

### A.6 Scoring 定数 — ADR 外、実装で定義

Decision 5 の scoring formula の具体的な定数値 (λ, bonus 重み, top guarantee 件数, per-service cap 等) は本 ADR の normative text には含めない。

- 定数は実装コード内で `exported const` として定義し、チューニング可能にする
- 初期値は実装計画で決定し、validation シナリオ (5 scenarios, 8pt max) で実測検証する
- 定数変更は ADR amendment を必要としない（構造変更は amendment が必要）

## Related

- [ADR 0008: Problem Grouping Without LLM](0008-problem-grouping-and-packetization-without-llm.md)
- [ADR 0013: Cross-Platform Storage Driver](0013-cross-platform-storage-driver.md)
- [ADR 0016: Incident Packet v1alpha](0016-incident-packet-v1alpha.md)
- [ADR 0018: Incident Packet Semantic Sections](0018-incident-packet-semantic-sections.md)
- [ADR 0024: Storage Implementation with Drizzle](0024-storage-implementation-with-drizzle.md)
- [ADR 0025: Performance and Responsiveness Guardrails](0025-phase1-performance-and-responsiveness-guardrails.md)
- [ADR 0029: Ambient Read Model](0029-ambient-read-model.md)
- [ADR 0030: Incident State and Packet Rebuild](0030-incident-state-and-packet-rebuild.md) — superseded
- [ADR 0031: Platform Event Contract](0031-platform-event-contract.md)
- [Research: Telemetry Evidence Selection](../research/telemetry-evidence-selection-2026-03.md)
