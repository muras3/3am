# 3am

OSS tool that diagnoses serverless app incidents in under 5 minutes using OTel data + LLM.

## 絶対ルール: AI Chat は LLM-first (synthesis を迂回するな)

**AI Chat / evidence-query 機能で「LLM synthesis を経由せず deterministic template を最終出力に返すパターン」は、LLM プロバイダ到達不可等の完全障害時を除き、絶対にゼロ。**

対象: `apps/receiver/src/domain/evidence-query.ts`、`packages/cli/src/commands/manual-execution.ts`、および AI Chat / 質問応答に関わる全ての経路。

### 研究整合的な分業（2025年以降の grounded QA / enterprise RAG 主流）

| 層 | 担当 | 理由 |
|----|------|------|
| **検出層 (detection)** | deterministic OK | `diagnosisState=pending/unavailable` / `evidence_count=0` / provider-down 等の事実判定は code 側に残す。LLM 丸投げは AbstentionBench (NeurIPS 2025) の指摘通り未解決問題。 |
| **合成層 (synthesis)** | **LLM 必須** | 回答文生成は必ず LLM を通す。state/count/claim を入力として LLM に渡し、自然文を生成させる。「該当ログ無し」のような答えも LLM synthesis で。 |
| **検証/修復層 (verify/repair)** | deterministic 実行 | invalid ref の削除・citation 検証・faithfulness check は post-process で（CiteFix ACL 2025 Industry、Generate-but-Verify IJCNLP-AACL 2025）。 |
| **最終 safety net** | deterministic OK | LLM プロバイダ到達不可、retry 複数回失敗時のみ deterministic template を許容。 |

### 禁止される実装

- keyword match で intent を分類し **LLM を経由せず** template 応答（挨拶・定義質問・診断状態別・no-evidence の deterministic no-answer 等）
- ref validation で LLM 出力を reject した後、**retry / post-process repair なしで**すぐ deterministic template にフォールバック
- greeting / explanatory / root_cause 判定を code 側で完結させ LLM を迂回

### 正しい実装

- state/count/absence-type 等の事実は code で検出し、**その事実を入力として LLM に渡して回答を生成**させる
- hallucination 対策は retry (ref 制約を段階的に緩和) + post-process (invalid ref を削除・再生成)
- deterministic safety net は retry 2回失敗後の最終段のみ
- 絶対に除外できない safety gate（緊急エスカレーション等）は deterministic 併用可、ただし **回答生成自体**は LLM で

### 例外導入のハードル

`AI synthesis を経由せず回答を返す経路` を新規追加する場合、事前にユーザーへ以下を提示して許可を取る:
- なぜ LLM 経路で実現できないか
- retry / post-process / structured input 等の代替を検討したか
- 当該経路を導入する impact（false positive / i18n / 説明力欠落のコスト）

### 根拠

2025年以降の研究・公式 docs は一貫して `deterministic detection + LLM synthesis + verification/repair` の分業を推奨:

- Microsoft Azure AI Search *agentic retrieval* (2025-2026 docs): raw extraction より LLM answer synthesis
- Anthropic Citations API (2025-06-23): prompt 工夫より built-in citation grounding の方が valid pointers を保証
- Filice et al. *Generate but Verify* (IJCNLP-AACL 2025): faithfulness-aware generate+verify が downstream improvement に直結
- Maheshwari et al. *CiteFix* (ACL 2025 Industry): post-process citation correction で +15.46% accuracy
- Hwang et al. *RA-RAG* (EMNLP 2025): source reliability-aware retrieval
- AbstentionBench (NeurIPS 2025): LLM の abstention 能力自体は未解決 → abstain 判定は code 側に残せ

「deterministic 分岐を主系、LLM を例外」という設計は現在の主流でも推奨でもない。

## Quick Start

**Local:**
```bash
cd validation
docker compose up -d
docker compose exec scenario-runner node run.js third_party_api_rate_limit_cascade
ls validation/out/runs/
```

**Staging (CF Workers receiver):**
```bash
cd validation
# First time: cp .env.staging.example .env.staging  →  fill RECEIVER_ENDPOINT + RECEIVER_AUTH_TOKEN
make check-env
make cf
# or step-by-step: make cf-up && make cf-run SCENARIO=<id> && make cf-down
```
See `validation/Makefile` for all targets (`make help`).

## Product Architecture (Monorepo)

```
apps/
  receiver/     # Hono backend — OTLP ingest / anomaly detection / packetizer / console API
  console/      # React + Vite SPA
packages/
  core/         # 3am-core — incident packet Zod schema, formation types
  diagnosis/    # 3am-diagnosis — LLM diagnosis engine (Anthropic SDK)
  cli/          # 3am-cli — thin wrapper around diagnosis
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

**Claude への厳禁事項（絶対に破るな）:**
- `develop` または `main` への直接コミット禁止。必ず `feat/*` 等のブランチを切って PR を出し、ユーザーの明示的な承認を得てからマージすること
- ユーザーの確認なしに PR をマージすること禁止

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

### Prompts For Murase

Murase 自身への促しとして、以下を毎回確認すること。

- 設計や部分テストが正しくても、最後に「ユーザーが実際に使う 1 コマンド / 1 画面 / 1 導線」を自分で通したか
- AI やレビュー担当に依頼するとき、受け入れ条件と failure path を最初に明示したか
- ADR にする前に、まだ仮説段階のものを重い意思決定として固定しすぎていないか

Murase の最も強い点は、抽象設計を実装可能な contract に落として、境界を崩さず前進できること。そこは維持しつつ、最後の 5% の運用導線確認を甘くしないこと。

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
- テストのアサーションは設計ドキュメント（shared-assumptions, data-requirements）の contract に準拠すること。実装の現在の挙動に合わせてはならない
- optional 依存（LLM, 外部 API, Stage 2 結果）を持つ関数は、依存なしで deterministic fallback が動作するテストを必須とする
- 「依存なし → 空配列 → green」は degraded path テストとして認めない。設計が非空を要求するならテストも非空をアサートする

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

## Session Hygiene (ユーザーへの促し)

セッション開始時または長くなってきたタイミングで、以下をユーザーに確認すること：

- **今日のスコープを明示してもらう** — 「今日はどこまでやりますか？」と聞く。「Phase X まで」が決まっていれば、Claude が勝手に先へ進まない
- **成功条件を合意する** — コマンドを実行する前に「どういう状態になったら OK か」を確認する
- **重要な制約は CLAUDE.md か ADR に書いてもらう** — 「検証用コードは validation/ に」のような判断は会話の中に埋めず、ここに残す

コンテキストが長くなっていると感じたら `/compact` を提案すること。

## Gotchas

- `depends_on` alone does NOT guarantee PostgreSQL readiness. Always use healthcheck + condition
- loadgen is an HTTP server, not a script. Use `/__admin/profile` for runtime profile switching
- `trigger` (external cause: "flash sale") and `trigger_signal` (first observable symptom: "Stripe 429") are distinct concepts
- probe-investigate schema has `additionalProperties: false`. Extension fields MUST go in `validation_extensions`

## Design System (console UI)

Source of truth: `docs/mock/incident-console-v3.html`

### Aesthetic direction

**Tone:** editorial-utilitarian — a technical ops tool with precision and restraint. Not playful, not corporate. Think: a Bloomberg terminal that a designer cleaned up.

**The one thing to remember:** warm neutral canvas + single aggressive accent (#E85D3A) + monospaced data. Everything else recedes.

### Tokens (HARD CONSTRAINTS — never deviate)

```css
/* Surfaces */
--bg: #FAFAF8;        /* app background */
--panel: #FFFFFF;
--panel-2: #F5F5F2;
--panel-3: #EEEEE8;

/* Ink */
--ink: #1A1A1A;
--ink-2: #4A4A48;
--ink-3: #6F6F68;

/* Borders */
--line: rgba(26,26,26,0.14);
--line-strong: rgba(26,26,26,0.24);

/* Semantic colors */
--accent: #E85D3A;              /* alerts, CTAs, critical */
--accent-soft: rgba(232,93,58,0.08);
--teal: #0D7377;                /* system/internal indicators */
--teal-soft: rgba(13,115,119,0.08);
--amber: #B8860B;               /* external dependency */
--amber-soft: rgba(184,134,11,0.08);
--good: #2E7D52;                /* healthy/resolved */
--good-soft: rgba(46,125,82,0.08);

/* Typography */
--font: 'DM Sans', system-ui, sans-serif;
--mono: 'JetBrains Mono', ui-monospace, monospace;

/* Shape */
--radius: 6px; --radius-sm: 4px; --radius-xs: 2px;

/* Type scale */
--fs-xxs: 10px; --fs-xs: 11px; --fs-sm: 12px;
--fs-md: 13px; --fs-lg: 16px; --fs-xl: 20px;
```

### Rules

- **NEVER** introduce color values not in this token list
- **NEVER** use Inter, Roboto, Arial, or system-ui as the primary font
- All spacing from 4px grid
- Data/metrics/IDs always use `--mono`; prose/labels use `--font`
- Motion: subtle only — pulse animations, fade-ins. No bouncy or playful effects
- Density: information-dense. Prefer compact rows over cards with lots of whitespace

### Layout (3-column)

```
Left rail 180px  |  Center (flex-1)  |  Right rail 220px
Incident list    |  Incident Board   |  AI Copilot
```
