# 3amoncall

OSS tool that diagnoses serverless app incidents in under 5 minutes using OTel data + LLM.

## Quick Start

```bash
cd validation
docker compose up -d
docker compose exec scenario-runner node run.js third_party_api_rate_limit_cascade
ls validation/out/runs/
```

## Product Architecture (Monorepo)

```
apps/
  receiver/     # Hono backend — OTLP ingest / anomaly detection / packetizer / console API
  console/      # React + Vite SPA
packages/
  core/         # @3amoncall/core — incident packet Zod schema, formation types
  diagnosis/    # @3amoncall/diagnosis — LLM diagnosis engine (Anthropic SDK)
  cli/          # @3amoncall/cli — thin wrapper around diagnosis
  config-typescript/ config-eslint/  # shared config (private)
```

## Commands

```bash
pnpm build       # build all packages (Turborepo)
pnpm test        # run all tests
pnpm lint        # lint all packages
pnpm typecheck   # typecheck all packages
pnpm dev         # start dev servers
```

## Validation Stack

```
validation/
  docker-compose.yml
  apps/
    web/                  # Express + TypeScript, OTel-instrumented
    mock-stripe/          # External API mock with admin API
  tools/
    scenario-runner/      # Scenario orchestrator + artifact-writer script
    loadgen/              # HTTP server-based load generator with control API
  otel/
    collector-config.yaml # OTLP receiver -> file export
  scenarios/
    <scenario_id>/
      scenario.yaml               # Scenario definition (summary ground_truth only)
      ground_truth.template.json   # Source of truth (probe-investigate schema compatible)
  out/
    runs/<timestamp>-<scenario_id>/  # Fixture output
docs/
  product-concept-v0.1.md
  validation-mvp-v0.1.md
  local-validation-stack-v0.1.md
  compose-and-scenario-draft-v0.1.md
```

## Tech Stack (Product)

- **Package manager**: pnpm@10.31.0 + Turborepo
- **Receiver / Console API**: Hono
- **Console UI**: React 19 + Vite 7 (SPA), TanStack Router + Query
- **Storage**: Drizzle ORM (CF D1 / Vercel Postgres / Memory)
- **Diagnosis**: Anthropic SDK, GitHub Actions runtime

## Tech Stack (Validation)

- **Runtime**: Node.js + TypeScript (ESM)
- **Web**: Express
- **DB**: PostgreSQL 16
- **OTel**: @opentelemetry/sdk-node, OTLP exporter
- **Containers**: Docker Compose V2
- **Loadgen**: Custom HTTP server (not k6)

## Key Conventions

- Source of truth for ground_truth is `ground_truth.template.json`. The ground_truth in scenario.yaml is a reference summary only
- ground_truth schema is compatible with probe-investigate's `scenario.schema.json`. Validation-specific extensions go in the `validation_extensions` object
- artifact-writer is NOT a separate container. It's a script inside scenario-runner
- `db_connection_count` red herring is collected via web's connection pool metric (no PostgreSQL exporter needed)

## Docker Compose

- Requires Compose V2 (`docker compose`, no `version` field)
- PostgreSQL uses `healthcheck` + `condition: service_healthy` for readiness
- loadgen and mock-stripe expose `/__admin/*` control APIs for scenario-runner

## Validation Workflow

1. `docker compose up` starts 6 containers
2. scenario-runner waits for health checks -> baseline traffic -> fault injection -> collection -> fixture generation
3. Feed fixture to LLM diagnosis and score (8pt max / 4 axes x 0-2)

## Scoring (4 axes, 8pt max)

| Axis | What |
|------|------|
| Immediate action effectiveness | Does the proposed action reduce blast radius? |
| Root cause accuracy | Can it distinguish trigger from internal design flaw? |
| Causal chain coherence | Does it explain timeline and shared resource collapse? |
| Absence of dangerous suggestions | Does it avoid harmful actions? |

Mapping to probe-investigate 10pt scale: 7-8 = 8-10, 5-6 = 5-7, 0-4 = 0-4

## Testing Model Selection

- Evaluate each scenario with at least 2 models
- Record model name and version in results
- Isolate prompt improvements from model changes

## Related Projects

- `probe-investigate` (`/Users/murase/project/probe-investigate/`): Validated diagnosis accuracy with synthetic fixtures (10 fixtures, avg 9.7/10, Sonnet 4.6 + v5 prompt)
- probe-investigate's `bench/schema/scenario.schema.json` is the canonical ground_truth schema

## Branching Strategy

- `main`: リリース専用。直接コミット禁止。`develop` からのマージのみ
- `develop`: 開発統合ブランチ。全フィーチャーブランチのマージ先
- `feat/*`, `fix/*`, `docs/*` 等: `develop` base で作成し `develop` へ PR

## ADR (Architecture Decision Records)

- ADRs live in `docs/adr/`. Numbered sequentially (e.g. `0011-...`).
- **Record architectural decisions proactively** — if you're making a non-obvious choice (data format, component boundary, evaluation strategy, tooling), write an ADR before or immediately after implementing it.
- When in doubt, err on the side of writing one. ADRs are cheap; undocumented decisions are expensive.
- Existing ADRs: 0001–0026. Check them before re-litigating settled decisions.

## Completion Discipline

実装完了とフェーズ完了を混同しないこと。

- 自分が実装したコードについて、自分で `Phase A/B/C complete` と判断しない
- `tests passed` は完了の根拠として不十分
- 追加したテストが narrow で、本質的な欠陥を見逃している可能性を必ず考える
- コードが増えたことと、フェーズが完了したことは別

### Required Self-Check Before Claiming Progress

実装後は、必ず以下を列挙すること。

1. ADR 準拠で未達の点
2. security 上の未解決事項
3. contract がまだ緩い箇所
4. local では通るが platform では未検証の箇所
5. まだ存在しないテスト
6. なぜこの変更だけでは `Phase X complete` と言えないか

### Phase Completion Rule

フェーズ完了は、実装者が宣言してはいけない。
フェーズ完了は、以下を満たしたときにのみ、人間または別レビュー担当が判定する。

- ADR 準拠
- contract tests green
- required integration tests green
- security review で blocker なし
- non-functional requirements に重大未達なし

### Testing Discipline

- unit test が通っても安心しない
- memory adapter だけで通っても安心しない
- `200 OK` を返すだけの stub で green でも安心しない
- local happy path だけでなく、failure path と boundary path があるか確認する
- auth, payload size, strict validation, persistence, callback を必ず疑う

### Anti-Pattern To Avoid

以下の状態で `done` と言わないこと。

- TODO が残っている
- auth が未実装
- platform-specific behavior が未検証
- unknown fields を silently strip している
- strict validation がない
- thin event / packet / diagnosis result の責務が曖昧
- required tests が存在しない
- review 観点が narrow すぎる

### Required Final Output Style

実装後の報告では、必ず以下の順で書くこと。

1. 実装したこと
2. 実行したテスト
3. 未解決のリスク
4. 未達の ADR / contract / security 項目
5. 次に進んでよいかどうかの保留条件

`done`, `complete`, `Phase X finished` という表現は、人間が明示的に確認するまで使わないこと。

## Gotchas

- `depends_on` alone does NOT guarantee PostgreSQL readiness. Always use healthcheck + condition
- loadgen is an HTTP server, not a script. Use `/__admin/profile` for runtime profile switching
- `trigger` (external cause: "flash sale") and `trigger_signal` (first observable symptom: "Stripe 429") are distinct concepts
- probe-investigate schema has `additionalProperties: false`. Extension fields MUST go in `validation_extensions`
