# Compose And Scenario Draft v0.1

> 目的: `third_party_api_rate_limit_cascade` をローカル検証環境で実行するための、`docker-compose.yml` と `scenario.yaml` の草案を固定する。

## 1. 前提

これは実装前のドラフトであり、最初から production-ready を狙わない。  
重要なのは、最小の労力で 1 シナリオを deterministic に再現し、OTel fixture を吐けること。

前提: Docker Compose V2（`docker compose` コマンド）を使用する。`version` フィールドは Compose V2 では不要なため省略。`depends_on.condition` は Compose V2 機能。

## 2. `docker-compose.yml` 草案

以下の構成を最初のベースラインとする。

```yaml
services:
  web:
    build:
      context: ./apps/web
    environment:
      PORT: "3000"
      NODE_ENV: development
      PAYMENT_BASE_URL: http://mock-stripe:4000
      DATABASE_URL: postgres://validation:validation@postgres:5432/validation
      OTEL_SERVICE_NAME: validation-web
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
      CHECKOUT_CONCURRENCY: "16"
      CHECKOUT_TIMEOUT_MS: "30000"
      RETRY_MAX_ATTEMPTS: "5"
      RETRY_INTERVAL_MS: "100"
      RETRY_BACKOFF_MODE: fixed
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy
      mock-stripe:
        condition: service_started
      otel-collector:
        condition: service_started

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: validation
      POSTGRES_PASSWORD: validation
      POSTGRES_DB: validation
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U validation"]
      interval: 5s
      timeout: 3s
      retries: 5

  mock-stripe:
    build:
      context: ./apps/mock-stripe
    environment:
      PORT: "4000"
      DEFAULT_MODE: normal
      DEFAULT_LATENCY_MS: "120"
      RATE_LIMIT_STATUS: "429"
      RATE_LIMIT_LATENCY_MS: "250"
    ports:
      - "4000:4000"

  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.101.0
    command: ["--config=/etc/otelcol/config.yaml"]
    volumes:
      - ./otel/collector-config.yaml:/etc/otelcol/config.yaml:ro
      - ./out/collector:/var/lib/otel
    ports:
      - "4317:4317"
      - "4318:4318"

  loadgen:
    build:
      context: ./tools/loadgen
    environment:
      TARGET_BASE_URL: http://web:3000
      LOADGEN_PROFILE: baseline
      LOADGEN_SEED: "42"
    depends_on:
      - web

  scenario-runner:
    build:
      context: ./tools/scenario-runner
    environment:
      SCENARIO_FILE: /workspace/scenarios/third_party_api_rate_limit_cascade/scenario.yaml
      OUTPUT_DIR: /workspace/out/runs
      WEB_BASE_URL: http://web:3000
      STRIPE_ADMIN_URL: http://mock-stripe:4000/__admin
      LOADGEN_CONTROL_URL: http://loadgen:8080
      OTEL_COLLECTOR_DIR: /workspace/out/collector
    volumes:
      - ./scenarios:/workspace/scenarios:ro
      - ./out:/workspace/out
    depends_on:
      - web
      - mock-stripe
      - loadgen
      - otel-collector

```

注: `artifact-writer` は `scenario-runner` コンテナ内のスクリプトとして実行する。別コンテナにはしない。

## 3. Compose 設計メモ

この compose 草案で重要なのは 4 点だけ。

- `web` の retry policy を env var で固定できる
- `mock-stripe` の mode を管理 API で切り替えられる
- `otel-collector` はファイル出力だけに徹する
- `scenario-runner` が orchestration の単一責任を持つ

`artifact-writer` は最初は `scenario-runner` の後段で都度起動してもよい。常駐させる必要はない。

## 4. `otel/collector-config.yaml` の最小ドラフト

```yaml
receivers:
  otlp:
    protocols:
      grpc:
      http:

processors:
  batch:

exporters:
  file/traces:
    path: /var/lib/otel/traces.json
  file/logs:
    path: /var/lib/otel/logs.jsonl
  file/metrics:
    path: /var/lib/otel/metrics.json

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [file/traces]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [file/logs]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [file/metrics]
```

ここでは collector の加工は最小限にする。  
シグナル整形は `artifact-writer` 側で行う方が変更しやすい。

## 5. `scenario.yaml` 草案

パス想定: `validation/scenarios/third_party_api_rate_limit_cascade/scenario.yaml`

```yaml
scenario_id: third_party_api_rate_limit_cascade
title: Flash sale triggers payment rate limiting and retry storm
description: >
  Flash sale traffic increases checkout requests. The payment dependency starts
  returning HTTP 429. The app retries with fixed intervals and exhausts the
  shared checkout worker pool, causing queue buildup and route-wide 504s.

runtime:
  total_duration_sec: 780
  warmup_sec: 180
  steady_state_sec: 120
  incident_sec: 300
  cooldown_sec: 180

services:
  web:
    base_url: http://web:3000
    healthcheck: /health
  payment_dependency:
    admin_url: http://mock-stripe:4000/__admin
    state_url: http://mock-stripe:4000/__admin/state
  loadgen:
    control_url: http://loadgen:8080

traffic:
  baseline:
    rps: 8
    routes:
      - path: /checkout
        method: POST
        weight: 70
      - path: /orders/demo-order
        method: GET
        weight: 20
      - path: /health
        method: GET
        weight: 10
  flash_sale:
    rps: 80
    routes:
      - path: /checkout
        method: POST
        weight: 85
      - path: /orders/demo-order
        method: GET
        weight: 10
      - path: /health
        method: GET
        weight: 5

fault_injection:
  at_sec: 300
  target: payment_dependency
  action:
    mode: rate_limited
    config:
      status_code: 429
      response_latency_ms: 250
      headers:
        x-ratelimit-limit: "100"
        x-ratelimit-remaining: "0"
        retry-after: "1"

application_profile:
  checkout_concurrency: 16
  timeout_ms: 30000
  retry:
    max_attempts: 5
    interval_ms: 100
    backoff: fixed
  queue:
    max_depth: 500

expected_observations:
  traces:
    - increased span duration on checkout path
    - repeated payment dependency child spans
    - growing queue_wait_ms on orchestrated routes
  logs:
    - payment 429 responses
    - retry attempt logs
    - request timeout logs
  metrics:
    - payment_429_count rises after fault injection
    - worker_pool_in_use saturates at 16
    - queue_depth rises steadily
    - route_504_count spreads beyond checkout

red_herrings:
  - recent deploy event unrelated to concurrency behavior
  - elevated db_connection_count without matching db latency increase
  - payment provider status page remains operational

ground_truth:
  _note: >
    scenario.yaml の ground_truth は参照用サマリ。
    正本は ground_truth.template.json（probe-investigate 互換形式）。
  trigger: flash sale traffic spike
  root_cause: fixed-interval retry policy against a rate-limited payment dependency exhausted the shared checkout worker pool
  immediate_action: disable or reduce retries, apply backoff or circuit breaker
```

## 6. `loadgen` 制御 API の最小仕様

`scenario-runner` から deterministic に操作するため、`loadgen` には最低限これだけ必要。

```yaml
POST /__admin/profile
  body:
    profile: baseline | flash_sale | stop

GET /__admin/state
  response:
    profile: baseline
    current_rps: 8
    started_at: "2026-03-06T10:00:00Z"
```

`k6` を直接扱うより、薄い HTTP ラッパを置いた方が `scenario-runner` が簡単になる。

## 7. `scenario-runner` の最小フロー

```text
1. compose 起動確認
2. web と mock-stripe の health check 通過待ち
3. loadgen を baseline に設定
4. warm-up
5. flash_sale に切り替え
6. at_sec 到達で mock-stripe を rate_limited に切り替え
7. incident window 終了まで継続
8. loadgen 停止
9. collector flush 待ち
10. artifact-writer 実行
11. run summary 出力
```

## 8. 最初に保存すべき `events.json`

```json
[
  {
    "ts": "2026-03-06T10:00:00Z",
    "type": "scenario_started",
    "scenario_id": "third_party_api_rate_limit_cascade"
  },
  {
    "ts": "2026-03-06T10:03:00Z",
    "type": "load_profile_changed",
    "profile": "flash_sale"
  },
  {
    "ts": "2026-03-06T10:05:00Z",
    "type": "dependency_mode_changed",
    "service": "mock-stripe",
    "mode": "rate_limited"
  },
  {
    "ts": "2026-03-06T10:10:00Z",
    "type": "scenario_completed"
  }
]
```

このイベント列があるだけで、LLM が時系列を組み立てやすくなる。

## 9. 実装上の妥協点

最初の版では、以下を許容してよい。

- `recent deploy event` は `events.json` に人工的に混ぜる
- PostgreSQL は入れるが、最初のシナリオでは `web` が orders 保存と読み取りに使うだけ
- `db_connection_count` の red herring は `web` の connection pool メトリクス（`db.client.connections.usage` 等）から収集。PostgreSQL exporter は不要で、app 側の OTel instrumentation で十分
- キャッシュ層は最初は不要

## 10. 次のアクション

このドラフトをそのまま実ファイルに落とすなら、最初に必要なのは以下。

1. `validation/docker-compose.yml`
2. `validation/otel/collector-config.yaml`
3. `validation/scenarios/third_party_api_rate_limit_cascade/scenario.yaml`
4. `validation/scenarios/third_party_api_rate_limit_cascade/ground_truth.template.json`
5. `validation/tools/scenario-runner` の stub（artifact-writer スクリプトを含む）
6. `validation/tools/loadgen` の stub（HTTP サーバー + 制御 API）
7. `validation/apps/mock-stripe` の stub
8. `validation/apps/web` の stub

ここまで作れば、実装に入れる。
