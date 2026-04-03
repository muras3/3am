# Telemetry Evidence Selection for Incident Diagnosis — Research Report

**Date:** 2026-03-17
**Context:** TelemetryStore 再設計に伴う packetizer 選別アルゴリズムの設計根拠。metrics/logs の選別が未実装（traces のみ 2-stage scoring 実装済み）であり、研究知見に基づいたアルゴリズム設計を行うための調査。

---

## 1. OTel の Signal Correlation 思想

### 3 シグナルの相関モデル

OTel は traces / metrics / logs を 3 つの共有識別子で相関させる:

- **Trace context** (`trace_id`, `span_id`): 主要な相関軸。16-byte trace ID がリクエストをサービス横断で追跡。Log record にも `trace_id` / `span_id` が自動注入される
- **Resource attributes**: `service.name`, `deployment.environment.name` 等。全シグナル共通で、exact correlation を可能にする
- **Semantic conventions**: 標準化された属性名（`http.response.status_code`, `db.system` 等）。ベンダー非依存のクエリを可能にする

OTel はシグナル間の「優先順位」を規定しない。各シグナルは異なる問いに答える:
- **Traces**: 「このリクエストで何が起きたか？」
- **Metrics**: 「システムは時間経過でどう振る舞っているか？」
- **Logs**: 「どんな具体的イベントが発生したか？」

### Log Severity モデル

OTel は 6 範囲 × 4 段階 = 24 の severity level を定義:

| Range | SeverityNumber | 用途 |
|-------|---------------|------|
| TRACE | 1-4 | 最も詳細なデバッグ情報 |
| DEBUG | 5-8 | デバッグ情報 |
| INFO | 9-12 | 通常動作の記録 |
| WARN | 13-16 | 注意が必要な状態 |
| ERROR | 17-20 | エラー発生 |
| FATAL | 21-24 | 致命的障害 |

SeverityNumber >= 17 で ERROR 以上をプログラム的に判定可能。これは scoring の severity tier に直接利用できる。

### 3am への適用

- Log の `trace_id` / `span_id` 属性を使い、anomalous span と correlated な log を優先選択できる
- Resource attributes による exact match で service affinity scoring が可能
- Severity model をそのまま scoring の重み付けに使える

---

## 2. AIOps / LLM-Based Incident Diagnosis の最新研究

### 2.1 RCACopilot (Microsoft, EuroSys 2024)

**最も直接的に参考になるシステム。**

- **2段階テレメトリ処理**: (1) 複数ソースから診断情報を集約、(2) **中間 LLM 呼び出しで要約**してから本体の診断 LLM に渡す
- **要約の効果**: 120-140 words への要約で **+0.077 Micro-F1 精度向上**（生データ直渡しと比較）
- **Incident matching**: Embedding ベースの類似 incident 検索 → few-shot example として使用
- **設計原則**: 「**Summarize narratives, preserve structured data**」— narrative データ（logs）は要約、structured データ（metrics JSON, ranked list）はそのまま渡す
- **Microsoft 本番環境で数ヶ月運用**

**参考文献**: [Automatic Root Cause Analysis via Large Language Models for Cloud Incidents](https://yinfangchen.github.io/assets/pdf/rcacopilot_paper.pdf)

### 2.2 OpenRCA (Microsoft, ICLR 2025)

- **Benchmark**: 3 つの enterprise system から 335 failures、68 GB のテレメトリ（metrics, logs, traces を CSV 化）
- **RCA-agent**: Multi-agent system。Python でデータ取得・分析を行い、LLM は推論に集中。大量テレメトリを LLM context に入れない
- **重要な知見**: 最良モデル（Claude 3.5）でも naive に全テレメトリを渡すと **11.34% しか解決できない**。専用の retrieval/selection が必須

**参考文献**: [OpenRCA: Can Large Language Models Locate the Root Cause of Software Failures?](https://openreview.net/pdf?id=M4qNIzQYpd)

### 2.3 eARCO (2025) — Embedding ベース RCA

- **Top-10** semantically similar な過去 incident を embedding vector で検索
- RCA 精度を RAG ベース LLM 比 **21% 向上**
- **180K** の過去 incident、**1,000+** サービスでトレーニング

**参考文献**: [eARCO: Efficient Automated Root Cause Analysis with Prompt Optimization](https://arxiv.org/html/2504.11505v1)

### 2.4 COCA (ICSE 2025) — Code-Augmented RCA

- テレメトリにコード知識（call graph による実行パス再構築）を補完
- **Logging Source Retrieval**: log メッセージのコード位置を特定し実行パスを再構築
- テレメトリのみのアプローチと比較して root cause 特定精度 **28.3% 向上**

**参考文献**: [COCA: Generative Root Cause Analysis for Distributed Systems with Code Knowledge](https://arxiv.org/abs/2503.23051)

### 2.5 RC-LLM (2026) — Hierarchical Telemetry Fusion

- Residual-connection 構造でマルチソーステレメトリを統合
- 時間的・サービス間の因果依存関係をモデル化

**参考文献**: [Root Cause Analysis Method Based on Large Language Models with Residual Connection Structures](https://arxiv.org/html/2602.08804v1)

### 2.6 HeMiRCA — Metric-level Fine-Grained RCA

- **Spearman 相関**で trace ベースの anomaly score と metric の時系列変化を相関
- 相関が高い metric = incident に関連が深い
- Service level と metric level の両方でランキング

**参考文献**: [HeMiRCA: Fine-Grained Root Cause Analysis](https://dl.acm.org/doi/10.1145/3674726)

### 2.7 MRCA (ASE 2024) — Multi-source RCA

- Traces + logs を使い、reconstruction probability で異常サービスをランキング
- 異常サービスから因果グラフを構築
- Reward mechanism で過剰な因果グラフ拡張を抑制

**参考文献**: [MRCA: Metric-level Root Cause Analysis](https://dl.acm.org/doi/abs/10.1145/3691620.3695485)

### 2.8 TAMO — Multi-Modality Observation

- Dual-branch collaborative diffusion でマルチモダリティ alignment
- 周波数ドメイン attention で root cause 特定

**参考文献**: [TAMO: Tool-Assisted LLM Agent with Multi-Modality Observation](https://arxiv.org/html/2504.20462v4)

### 2.9 LLM4AIOps Survey (ACM Computing Surveys)

- 183 研究論文（2020-2024）を分析
- 主要課題: テレメトリデータは「predominantly non-natural language」— 数値、GUID、エラーコード等、LLM が苦手とする形式

**参考文献**: [A Survey of AIOps in the Era of Large Language Models](https://dl.acm.org/doi/10.1145/3746635)

---

## 3. Observability Platform の実践アプローチ

### 3.1 Datadog Watchdog RCA

- **自動 baseline 計算**: metric ごとに expected behavior を学習、偏差をフラグ
- **Cross-signal correlation**: application と infrastructure のマッピング。APM anomaly 検知時に関連コンポーネントの anomaly を自動検索
- **Critical failure identification**: latency or error rate increase を常にアンカーシグナルとし、他の correlated anomaly を重ねる
- **設定不要**: APM と Log Management の全ユーザーに自動適用

**参考文献**: [Datadog Watchdog RCA](https://www.datadoghq.com/blog/datadog-watchdog-automated-root-cause-analysis/)

### 3.2 AiDice (Microsoft Azure) — Multidimensional Metric Anomaly Localization

**最も具体的な scoring アルゴリズム。**

- **Search-space formulation**: 多次元 metric を探索グラフとして定式化。ノードは dimension-value combination（例: "Country=USA, Datacenter=DC1, DiskType=SSD"）
- **目的関数（2 components）**:
  1. **Anomaly magnitude**: 突発的変化の大きさ
  2. **Error proportion**: 全エラー中の当該 pivot の占有率
- **Greedy search**: 複合目的関数を探索空間で最大化
- **スコア**: `anomaly_magnitude × error_proportion`

**参考文献**: [Advancing anomaly detection with AIOps — introducing AiDice](https://azure.microsoft.com/en-us/blog/advancing-anomaly-detection-with-aiops-introducing-aidice/)

### 3.3 Azure Monitor Observability Agent (Preview, 2024-2025)

- Impact 時刻から **2 時間のテレメトリ scan window**
- Metrics, logs, 関連 Azure resources を横断分析
- **Triangle System** (Multi-LLM-Agent triage): domain-specific agent が troubleshooting guide (TSG) で訓練。Local Triage agent が binary accept/reject → Global Triage が調整。**90% accuracy, 38% TTM reduction**

**参考文献**:
- [Azure Monitor Issue and Investigation](https://learn.microsoft.com/en-us/azure/azure-monitor/aiops/aiops-issue-and-investigation-overview)
- [Triangle System](https://azure.microsoft.com/en-us/blog/optimizing-incident-management-with-aiops-using-the-triangle-system/)

### 3.4 Grafana Sift — Automated Investigation Checks

- **Fan-out architecture**: Prometheus metrics, Loki logs, Tempo traces, Pyroscope profiles, SQL に対して specialist agent を並列実行
- **主要な check types**:
  - **Error Pattern Logs**: 類似 log line をグループ化、incident window で log rate が有意に増加したグループをハイライト
  - **HTTP Error Series**: cluster/namespace 内の HTTP error 上昇を検出
  - **Correlated Series**: incident metric と相関する metric を発見
  - **Recent Deployments**: デプロイ変更を潜在的原因として表示
- **Timeline overlay**: Sift check で発見したイベントを incident metric timeline 上にアノテーション

**参考文献**:
- [Grafana Sift](https://grafana.com/docs/grafana-cloud/machine-learning/sift/sift/)
- [Sift Error Pattern Logs](https://grafana.com/docs/grafana-cloud/machine-learning/sift/analyses/error-pattern-logs/)

### 3.5 Honeycomb BubbleUp — Statistical Distribution Comparison

- **Per-dimension 分布比較**: データの全属性について、選択した異常データと baseline データの分布を比較
- **Percentage difference でランキング**: anomaly と baseline の最大差分でソート
- **設定不要**: 全 dimension で自動動作

**参考文献**: [Honeycomb BubbleUp](https://www.honeycomb.io/platform/bubbleup)

### 3.6 HolmesGPT (CNCF Sandbox, Apache 2.0)

**3am と最もアーキテクチャが近い OSS ツール。**

- **Agentic tool-calling loop**: LLM が必要なデータを iterative に fetch。Per-tool output budget でコンテキスト溢れを防止
- **ソースでの集約**: fetch-then-filter ではなく、データソース側で filter/aggregation を push
- **Traversable JSON trees**: 大きな API response をツリー化し、filtering と depth-limiting で管理
- **Summarization transformers**: `llm_summarize` で secondary model が大きな tool output を condensation
- **Per-tool memory limits**: disk への streaming、自動出力予算

**参考文献**:
- [HolmesGPT (CNCF)](https://www.cncf.io/blog/2026/01/07/holmesgpt-agentic-troubleshooting-built-for-the-cloud-native-era/)
- [HolmesGPT GitHub](https://github.com/HolmesGPT/holmesgpt)

---

## 4. Metric 選別の具体的アルゴリズム

### 4.1 Baseline 比較手法

| 手法 | 原理 | 適用基準 | 出典 |
|------|------|---------|------|
| **Z-score** | `(value - mean) / stddev`、\|z\| >= 3 で異常判定 | 最も基本。Booking.com が本番使用 | [Booking.com](https://medium.com/booking-com-development/anomaly-detection-in-time-series-using-statistical-analysis-cc587b21d008) |
| **CUSUM** | baseline からの偏差の累積和。小さいが持続的な shift を検出 | z-score が見逃す gradual degradation に有効 | 統計的品質管理理論 |
| **KS2 test** | baseline window と incident window の分布を Kolmogorov-Smirnov 検定で比較 | Netdata が使用。統計的有意性の判定 | [Netdata](https://learn.netdata.cloud/docs/machine-learning-and-anomaly-detection/metric-correlations) |
| **Volume heuristic** | baseline と incident window の平均値の percentage change | 最もシンプル。計算コスト最小 | 一般的手法 |
| **AiDice objective** | `anomaly_magnitude × error_proportion` | 変化の大きさ × 全体に占める割合の複合スコア | [AiDice](https://azure.microsoft.com/en-us/blog/advancing-anomaly-detection-with-aiops-introducing-aidice/) |

### 4.2 Temporal Alignment

- **Netdata 方式**: incident window の **4 倍**の長さを baseline window として使用（例: incident 5 分 → 直前 20 分が baseline）
- **Anomaly score 正規化**: `score = 100 × (distance - min) / (max - min)`、score >= 99 で anomaly フラグ

### 4.3 Spearman 相関（HeMiRCA）

- Anomalous spans の時間分布と metric の変化タイミングの **Spearman 相関**を計算
- 相関係数が高い metric = incident に因果関係がある可能性が高い
- Service level と metric level の両方でランキング可能
- **3am への適用**: anomalousSignals の時間分布と metric datapoint の時間分布の相関。baseline 不要で動作する

### 4.4 Change Point Detection

| アルゴリズム | 計算量 | 特徴 | 適用場面 |
|------------|-------|------|---------|
| **PELT** (Pruned Exact Linear Time) | O(n) | globally optimal。BIC/AIC penalty で false positive 制御 | post-incident 分析 |
| **BOCPD** (Bayesian Online Change Point Detection) | online | run length since last change の posterior を更新。streaming 向き | リアルタイム検出 |

PELT: minimum segment length を設定して micro-segments を防止（例: daily data で min 7）
BOCPD: 2024 の研究で precision/F1 が baseline 比 **35%+ 向上**

---

## 5. Log 選別の具体的アルゴリズム

### 5.1 Template Extraction / Dedup

| 手法 | 原理 | パラメータ | 適用場面 |
|------|------|----------|---------|
| **Drain3** | Fixed-depth parse tree で online log template 抽出 | `sim_th=0.4`, `depth=4`, `max_children=100` | production-grade streaming。Kafka/Redis persistence 対応 |
| **簡易 regex 正規化** | 数値→`<NUM>`, UUID→`<UUID>`, IP→`<IP>` 等で置換 → fingerprint hash | 置換パターンの定義 | 少量 log で十分な dedup 効果（~80%） |
| **BIRCH clustering** | branching factor B=50, threshold T=0.5 で自動クラスタ数決定 | B, T | LogRCA (Euro-Par '24) で 44.3M log lines に適用 |

### 5.2 Scoring / Ranking

| 軸 | 手法 | 出典 |
|----|------|------|
| **Severity weighting** | OTel SeverityNumber: FATAL(21-24) > ERROR(17-20) > WARN(13-16) | OTel Logs Data Model |
| **Temporal decay** | `weight = e^(-λ × time_delta)`、incident detect 時刻からの距離で減衰 | [Temporal Decay Loss for Log Anomaly Detection](https://pmc.ncbi.nlm.nih.gov/articles/PMC12073674/) |
| **KPI correlation** (Log3C) | Log cluster の頻度変化と KPI（error rate, latency）の多変量線形回帰。`λ=0.2`, `α=0.05`。Precision 0.877, Recall 0.883 | [Log3C (FSE '18)](https://netman.aiops.org/~peidan/ANM2021/6.LogAnomalyDetection/LectureCoverage/2018FSE_Identifying%20Impactful%20Service%20System%20Problems%20via%20Log%20Analysis.pdf) |
| **Error rate spike** (Grafana Sift) | 類似 log line をグループ化 → incident window vs baseline の log rate spike を検出 | [Grafana Sift](https://grafana.com/docs/grafana-cloud/machine-learning/sift/analyses/error-pattern-logs/) |
| **Trace correlation** | `trace_id` / `span_id` で anomalous span と関連する log を優先 | OTel signal correlation |
| **Keyword relevance** | body に diagnostic keyword（timeout, connection refused, rate limit, OOM, circuit breaker）が含まれるか | 一般的ヒューリスティック |

### 5.3 推奨パイプライン

研究の consensus に基づく log 選別の 5 段階:

1. **Parse**: template 抽出（regex 正規化 or Drain3）
2. **Dedup**: template でグループ化、グループごとに count と代表 log を保持
3. **Score**: `severity_weight × temporal_proximity × (1 + log₂(count))`
4. **Select**: top-N template groups by score。各 group から代表 1-2 件
5. **Budget**: token budget に収まるよう hard cap

---

## 6. LLM Context Management の知見

### 6.1 中間要約の効果

- **RCACopilot**: 診断情報を中間 LLM で 120-140 words に要約 → **+7.7% 精度向上**
- **設計原則**: narrative data（logs）は要約、structured data（metrics JSON, ranked list）はそのまま
- **一部データは要約必須**: グラフトポロジ、application symptoms
- **一部データは raw 推奨**: statistical RCA ranked list

### 6.2 Context Compression 手法

| 手法 | 圧縮率 | 性能損失 | 出典 |
|------|-------|---------|------|
| **LLMLingua** (Microsoft) | 最大 20x | 1.5% (reasoning tasks) | Microsoft Research |
| **Extractive reranker** | 4.5x | +7.89 F1 (multi-hop QA で向上) | 2024 research |
| **Summarization + keyphrase** | 5-20x | 70-94% コスト削減 | 2024 survey |
| **ACON framework** | 26-54% peak token 削減 | task performance 維持 | [ACON](https://arxiv.org/pdf/2510.00615) |

### 6.3 Token-Budget-Aware Reasoning

- モデルを token budget 制約を内面化するように fine-tune 可能
- Budget-aware evaluation: 計算規模が推論アプローチ選択に有意に影響

---

## 7. 3am 既存実装の分析

### 7.1 Trace 選別アルゴリズム（実装済み）

`packetizer.ts` の `selectRepresentativeTraces()`:

#### scoreSpan — 加算式スコアリング

| 条件 | 加点 | 根拠 |
|------|------|------|
| `httpStatusCode >= 500` | +3 | Server error、高い診断価値 |
| `httpStatusCode === 429` | +3 | Rate limiting、重要な因果シグナル |
| `exceptionCount > 0` | +2 | Span 上の例外イベント |
| `spanStatusCode === 2` (ERROR) | +2 | OTel error status |
| `durationMs > 5000` (SLOW_SPAN_THRESHOLD) | +1 | Latency anomaly |
| `peerService !== undefined` | +1 | 外部依存関係のコンテキストボーナス |

最大理論スコア: 12（429 + peerService + exception + span error + slow の全該当）

#### Phase 1: Top Anomaly Guarantee

- 全 span を score 降順ソート（tiebreak: `traceId:spanId` 辞書順）
- score > 0 の上位 `TOP_ANOMALY_GUARANTEE = 3` 件を確保
- 後続 phase で**絶対に置換されない**

#### Phase 2: Diversity Fill（Greedy with Dynamic Service Preference）

Budget = `MAX_REPRESENTATIVE_TRACES (10) - guaranteed.length`

各 iteration で 2 パス:
- **Pass 1**: まだ Phase 2 で選ばれていない `serviceName` から最高スコアの span を選択（サービス多様性確保）
- **Pass 2 (fallback)**: 未出現サービスがなければ、任意のサービスから最高スコアを選択

両パスとも per-route cap を適用: `MAX_ROUTE_DIVERSITY = 3` per `${serviceName}:${httpRoute}`

#### Phase 3: Dependency Injection

Phase 1+2 の選択結果に `peerService` を持つ span がなければ、最高スコアの未選択 peerService span を注入:
- Phase 1 は不可侵
- Phase 2 picks から最後の score=0 を置換 / 全て score > 0 なら最後を置換
- 枠があれば追加

### 7.2 Metrics / Logs の現状（未実装）

#### ChangedMetric の構造

```typescript
{
  name: string,          // metric name (e.g., "http.server.request.duration")
  service: string,       // service.name
  environment: string,   // deployment.environment.name
  startTimeMs: number,   // observation timestamp
  summary: Record<string, unknown>  // datapoint shape (varies by type)
}
```

`summary` の内容:
- **Histogram**: `{ count, sum, min, max }`（bucket boundaries は除外）
- **Gauge**: `{ asDouble }` or `{ asInt }`
- **Sum/Counter**: `{ asDouble }` or `{ asInt }`

#### RelevantLog の構造

```typescript
{
  service: string,
  environment: string,
  timestamp: string,     // ISO string
  startTimeMs: number,   // numeric ms
  severity: string,      // "WARN" | "ERROR" | "FATAL" (>= WARN only)
  body: string,          // log message
  attributes: Record<string, unknown>  // all OTLP log record attributes
}
```

#### 現状のギャップ

**Metrics**:
- baseline / 偏差検出なし（`summary` は単一 datapoint、baseline 値なし）
- metric name の重要度分類なし
- anomalous spans との correlation 計算なし
- 同一 `(service, metricName)` の dedup なし
- service diversity mechanism なし

**Logs**:
- severity 重み付けなし（FATAL/ERROR/WARN が等価）
- diagnostic keyword 分析なし
- 同一メッセージの dedup なし
- service diversity なし
- temporal proximity weighting なし
- `traceId`/`spanId` による anomalous span との correlation なし

### 7.3 Anomaly Detector の既存計算

`anomaly-detector.ts` が計算するシグナル:

- `isAnomalous(span)`: HTTP 5xx, 429, spanStatus ERROR, duration > 5s, exceptionCount > 0
- `isIncidentTrigger(span)`: SERVER/INTERNAL 429 をフィルタ（意図的 rate limiting を除外）
- `isDependencyAuthFailure(span)`: peerService からの 401/403 + ERROR span status
- `selectIncidentTriggerSpans(spans)`: sliding window 60s, min 2 occurrences

`deriveSignalSeverity()` は span-derived signals + log severity で incident severity を計算（唯一 log が scoring に影響する箇所）。

---

## 8. アーキテクチャの Consensus

研究（RCACopilot, HolmesGPT, OpenRCA）と商用プラットフォーム（Grafana Sift, Datadog Watchdog）の consensus は **3層パイプライン**:

```
Layer 1: Collect
  OTel ingest → raw data storage
  (3am: OTLP ingest → TelemetryStore)

Layer 2: Score & Select
  anomaly scoring → ranking → diversity fill → bounded output
  (3am: packetizer — traces は実装済み、metrics/logs が未実装)

Layer 3: Format for LLM
  token budget management → prompt construction
  (3am: buildPrompt — safety net caps あり)
```

### Commercial / OSS ツール比較

| Tool | Evidence Selection Approach | Key Technique |
|------|---------------------------|---------------|
| **HolmesGPT** (CNCF) | Agentic tool-calling loop | Per-tool output budgets, `llm_summarize`, JSON tree traversal |
| **Datadog Watchdog** | 自動 baseline + cross-signal correlation | Learned expected behavior, anchor signal + correlated anomalies |
| **Grafana Sift** | Fan-out specialist agents | Error pattern logs, correlated series, recent deployments |
| **Honeycomb BubbleUp** | Per-dimension distribution comparison | Baseline vs anomaly 分布差でランキング |
| **AiDice** (Azure) | Greedy multidimensional search | `anomaly_magnitude × error_proportion` |
| **Komodor (Klaudia)** | Change correlation | Deploy/config/code changes vs pod/node status, >95% accuracy |
| **RCACopilot** (Microsoft) | Pre-selection + summarization | Handler-based collection, intermediate LLM summarization, top-K similar incidents |
| **Rootly AI** | CI/CD correlation | Alerts ↔ recent deployments, similar past incidents |

---

## 9. 参考文献一覧

### 学術論文

1. [RCACopilot (EuroSys '24)](https://yinfangchen.github.io/assets/pdf/rcacopilot_paper.pdf) — Microsoft. LLM-based automatic RCA with intermediate summarization
2. [OpenRCA (ICLR '25)](https://openreview.net/pdf?id=M4qNIzQYpd) — Microsoft. Benchmark + multi-agent RCA
3. [eARCO (2025)](https://arxiv.org/html/2504.11505v1) — Embedding-based RCA with prompt optimization
4. [COCA (ICSE '25)](https://arxiv.org/abs/2503.23051) — Code-augmented RCA
5. [RC-LLM (2026)](https://arxiv.org/html/2602.08804v1) — Hierarchical telemetry fusion
6. [HeMiRCA](https://dl.acm.org/doi/10.1145/3674726) — Spearman correlation for metric-level RCA
7. [MRCA (ASE '24)](https://dl.acm.org/doi/abs/10.1145/3691620.3695485) — Multi-source RCA with causal graphs
8. [TAMO](https://arxiv.org/html/2504.20462v4) — Multi-modality observation
9. [LLM4AIOps Survey (ACM)](https://dl.acm.org/doi/10.1145/3746635) — 183 papers survey
10. [Log3C (FSE '18)](https://netman.aiops.org/~peidan/ANM2021/6.LogAnomalyDetection/LectureCoverage/2018FSE_Identifying%20Impactful%20Service%20System%20Problems%20via%20Log%20Analysis.pdf) — KPI-correlated log clustering
11. [LogRCA (Euro-Par '24)](https://arxiv.org/html/2405.13599v1) — Semi-supervised log-based RCA
12. [MicroRCA-Agent](https://arxiv.org/html/2509.15635v1) — Drain + multi-level filtering + LLM
13. [LLMLogAnalyzer](https://arxiv.org/html/2510.24031v1) — LLM-based log analysis
14. [Temporal Decay Loss](https://pmc.ncbi.nlm.nih.gov/articles/PMC12073674/) — Adaptive log anomaly detection
15. [LogRules (NAACL Findings '25)](https://aclanthology.org/2025.findings-naacl.28.pdf) — Log parsing
16. [Lemur (2024)](https://arxiv.org/pdf/2402.18205) — Entropy sampling for log parsing
17. [ACON (2025)](https://arxiv.org/pdf/2510.00615) — Context compression for long-horizon agents
18. [Token-Budget-Aware Reasoning (2024)](https://arxiv.org/html/2412.18547v1) — Budget-constrained reasoning
19. [Comprehensive Survey on RCA in Microservices (2024)](https://arxiv.org/html/2408.00803v1) — Survey
20. [Change Point Detection with Deep Learning (2025)](https://link.springer.com/article/10.1007/s42524-025-4109-z) — Review

### Platform / Tool Documentation

21. [Datadog Watchdog RCA](https://www.datadoghq.com/blog/datadog-watchdog-automated-root-cause-analysis/)
22. [AiDice (Microsoft Azure)](https://azure.microsoft.com/en-us/blog/advancing-anomaly-detection-with-aiops-introducing-aidice/)
23. [Azure Monitor Issues and Investigations](https://learn.microsoft.com/en-us/azure/azure-monitor/aiops/aiops-issue-and-investigation-overview)
24. [Triangle System (Microsoft)](https://azure.microsoft.com/en-us/blog/optimizing-incident-management-with-aiops-using-the-triangle-system/)
25. [Grafana Sift](https://grafana.com/docs/grafana-cloud/machine-learning/sift/sift/)
26. [Grafana Sift Error Pattern Logs](https://grafana.com/docs/grafana-cloud/machine-learning/sift/analyses/error-pattern-logs/)
27. [Honeycomb BubbleUp](https://www.honeycomb.io/platform/bubbleup)
28. [HolmesGPT (CNCF Blog)](https://www.cncf.io/blog/2026/01/07/holmesgpt-agentic-troubleshooting-built-for-the-cloud-native-era/)
29. [HolmesGPT GitHub](https://github.com/HolmesGPT/holmesgpt)
30. [Netdata Metric Correlations](https://learn.netdata.cloud/docs/machine-learning-and-anomaly-detection/metric-correlations)
31. [Booking.com Anomaly Detection](https://medium.com/booking-com-development/anomaly-detection-in-time-series-using-statistical-analysis-cc587b21d008)
32. [Drain3 GitHub](https://github.com/logpai/Drain3)
33. [AIOpsLab (Microsoft)](https://www.microsoft.com/en-us/research/publication/aiopslab-a-holistic-framework-for-evaluating-ai-agents-for-enabling-autonomous-cloud/)
34. [RCAEval Benchmark](https://github.com/phamquiluan/RCAEval)
35. [OTel Semantic Conventions](https://opentelemetry.io/docs/concepts/semantic-conventions/)
36. [OTel Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
37. [OTel Signal Correlation](https://oneuptime.com/blog/post/2026-02-06-opentelemetry-signal-correlation-traces-logs-metrics/view)

### Curated Resource Lists

38. [Awesome LLM-AIOps](https://github.com/Jun-jie-Huang/awesome-LLM-AIOps)
39. [Awesome Failure Diagnosis](https://github.com/phamquiluan/awesome-failure-diagnosis)
