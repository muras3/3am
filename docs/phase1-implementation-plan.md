# Phase 1 Implementation Plan

## Goal

Phase 1 の実装を **spec-driven / contract-driven / test-driven** で進める。  
最優先は速度ではなく品質であり、特に以下を守る。

- 契約が先、実装が後
- ローカルで最大限壊れにくくする
- platform-specific 検証は境界面だけに絞る
- テストの妥協はしない

## Guiding Principles

### 1. Specs first

以下を source of truth とする。

- ADR 0015-0025
- `docs/mock/incident-console-v3.html`
- contract schema (`incident packet`, `diagnosis result`, `thin event`)

### 2. Contracts before code

各コンポーネントは先に契約を固定し、その後で実装する。

- packet schema
- diagnosis result schema
- thin event schema
- Receiver API schema

### 3. Test before integration

ローカルで契約・ロジック・read model を固めてから、GitHub Actions / Vercel / Cloudflare の境界テストに進む。

### 4. Responsiveness is quality

ADR 0025 に従い、速さそのものを品質の一部として扱う。

## Environment Responsibility Matrix

### Local

ローカルで担保すること:

- schema contract の整合
- packet generation の determinism
- diagnosis result shape
- thin event shape
- Receiver API contract
- StorageDriver behavior
- Console の first viewport 描画
- Evidence Studio の interaction
- GitHub Actions 相当の worker logic（mock runner / local harness）
- 既存 validation シナリオとの整合

ローカルで担保しないこと:

- GitHub Actions 自体の起動
- Vercel / Cloudflare の platform-specific runtime behavior
- D1 / Vercel Postgres の最終本番挙動

### GitHub Actions

GitHub Actions で担保すること:

- thin event で起動できる
- packet fetch が成功する
- diagnosis result callback が成功する
- retry / failure handling が期待通り

GitHub Actions で担保しないこと:

- incident formation の正しさそのもの
- UI rendering

### Vercel

Vercel で担保すること:

- Receiver deploy が成立する
- Postgres adapter が動く
- Console read path が遅すぎない
- OTLP ingest endpoint が reachability / auth を満たす

### Cloudflare

Cloudflare で担保すること:

- Receiver deploy が成立する
- D1 adapter が動く
- OTLP ingest endpoint が reachability / auth を満たす
- platform-specific adapter 差分が破綻していない

## CI/CD Architecture

### Principle

CI/CD は実装後に足すのではなく、Phase 1 開始前にアーキテクチャとして固定する。  
目的は以下である。

- local で壊れたものを platform に持ち込まない
- contract drift を早期に止める
- GitHub Actions / Vercel / Cloudflare の境界面を明示的に検証する

### Pipeline Stages

#### Stage 1: Fast local-equivalent CI

対象:

- typecheck
- lint
- schema contract tests
- domain tests
- adapter tests

目的:

- 最も安い失敗を最も早く止める

#### Stage 2: Local integration CI

対象:

- Receiver integration tests
- diagnosis local harness tests
- Console read-model / rendering tests

目的:

- コンポーネント間契約を CI 上で再現する

#### Stage 3: GitHub Actions self-verification

対象:

- thin event trigger test
- packet fetch test
- diagnosis result callback test

目的:

- Actions worker 自体の境界面を壊さない

#### Stage 4: Deployment boundary verification

対象:

- Vercel smoke
- Cloudflare smoke

目的:

- local では見えない platform-specific 差分を捕捉する

### Branch Policy For Delivery

- feature / fix / docs branches は `develop` 向け PR
- `develop` 上で CI green を要求する
- `main` は release 用のみ
- `develop -> main` の前に boundary verification を再実行する

### Merge queue policy

- `develop` に並列で複数 PR が流れる前提では merge queue を優先する
- merge queue を使う場合、required checks は queue 上でも再実行される前提で設計する
- required workflow は `merge_group` を考慮して構成する
- required checks に skip されうる path filter を混ぜない

目的:

- 並列開発時に `develop` を壊しにくくする
- 先に merge された PR による後続 PR の破綻を減らす

### Required checks mapping

`develop` に required check として最低限要求するもの:

- typecheck / lint
- contract tests
- domain tests
- local DB-backed tests
- local integration tests
- Playwright UI tests
- diagnosis regression suite

`main` 昇格前に追加で要求するもの:

- GitHub Actions self-verification
- Vercel smoke
- Cloudflare smoke

### Release / Rollback Policy

- `develop` は統合ブランチだが、release 候補として常時動作確認できる状態を維持する
- `main` へ上げる条件は以下をすべて満たすこと
  - local contract / domain / integration tests green
  - GitHub Actions self-verification green
  - Vercel smoke green
  - Cloudflare smoke green
  - diagnosis regression suite green
- `develop -> main` で platform smoke が失敗した場合、release は中止する
- release 後に boundary failure が見つかった場合は、`main` への追加変更ではなく、まず直近 release candidate を切り戻す判断を優先する
- rollback 手順は Phase 1 中に最低限以下を持つ
  - Vercel: 直前 deployment への rollback
  - Cloudflare: 直前 stable version への rollback
  - GitHub Actions: workflow 側 change は `main` 上の直前 green commit に戻す

## Security And Diagnosis Review

### Security review is a first-class gate

Phase 1 では、以下を毎回の実装レビュー項目に含める。

- OTLP ingest auth が Bearer Token 要件を満たしているか
- packet / diagnosis result に secret や過剰な raw data を保存していないか
- Receiver API が canonical store として過剰権限を持たせていないか
- GitHub Actions callback / fetch path の認証が明示されているか

### Secret ownership matrix

- local
  - developer-owned `.env` / shell env
  - 開発用 token のみ
- GitHub Actions
  - LLM API key
  - Receiver callback auth
  - repository dispatch / workflow auth
- Vercel / Cloudflare
  - OTLP Bearer Token
  - Receiver runtime secrets
- rule
  - LLM API key は Receiver に置かない
  - platform secrets と diagnosis secrets を混ぜない

### Diagnosis review is also a first-class gate

機能が動くだけでは不十分で、診断の妥当性を以下で見る。

- `What happened` が visible symptom と一致しているか
- `Immediate Action` が blast radius を本当に縮小するか
- `Why this action` が evidence と矛盾しないか
- `Do not` が有害行動を避けられているか

### Diagnosis regression suite

Phase 1 では diagnosis 品質の回帰を防ぐため、固定 regression set を持つ。

- required scenarios
  - `third_party_api_rate_limit_cascade`
  - `cascading_timeout_downstream_dependency`
  - `secrets_rotation_partial_propagation`
  - `upstream_cdn_stale_cache_poison`
  - `db_migration_lock_contention`
- required checks
  - schema-valid diagnosis result
  - scoring rubric で重大劣化がない
  - dangerous suggestion が入っていない
- rerun triggers
  - prompt version change
  - diagnosis package change
  - packet semantic change
  - evidence extraction change

### Review cadence

- schema / contract change時: contract review 必須
- Receiver / worker change時: security review + diagnosis review 必須
- UI change時: mock / chosen basis との比較レビュー必須

## Test Pyramid

### Layer 1: Contract tests

対象:

- packet schema
- diagnosis result schema
- thin event schema
- API request/response schema

目的:

- field drift 防止
- Claude Code / Sonnet 実装の暴走防止

必須:

- schema validation test
- backward-compatible parsing test
- minimal valid example test
- representative invalid example test

### Layer 2: Domain tests

対象:

- incident formation
- packet generation
- deterministic evidence extraction
- mitigation watch derivation
- read model composition

目的:

- business logic の正しさ担保

必須:

- scenario-based unit tests
- edge case tests
- property-like tests for stable grouping where useful

### Layer 3: Adapter tests

対象:

- StorageDriver adapters
- OTLP ingest handlers
- platform log ingest handlers
- diagnosis result persistence

目的:

- driver / adapter 差分吸収の検証

必須:

- shared adapter test suite
- D1/Postgres behavior parity tests
- serialization/deserialization tests

### Layer 3.5: Local DB-backed tests

対象:

- Postgres-backed storage tests
- SQLite-backed storage tests（D1 近似）
- migration application tests
- persistence / readback tests

目的:

- DB を伴う実際の永続化挙動をローカルで先に壊れないようにする

必須:

- local Postgres を起動して adapter tests を通す
- local SQLite を使って D1 近似テストを通す
- migration が空の DB から適用できることを確認する
- incident / packet / diagnosis result の保存と再取得が両系統で通ることを確認する

#### Bootstrap expectation

- local DB-backed tests は `make test-db` 相当の 1 コマンドで起動できるようにする
- CI でも同じ bootstrap を使う
- Sonnet 実装では、DB 起動手順を docs ではなく scripts に寄せる

### Layer 4: Local integration tests

対象:

- Receiver API + storage + packet generation
- diagnosis worker local stub
- Console read model

目的:

- 層を跨いだ整合確認

必須:

- incident created -> packet stored
- packet fetched -> diagnosis stored
- diagnosis reflected in Console API

### Layer 5: Platform boundary tests

対象:

- GitHub Actions
- Vercel
- Cloudflare

目的:

- local では見えない境界面だけを検証

必須:

- one happy path per environment
- one failure path per environment
- auth / callback / persistence の smoke test

## Phase Breakdown

### Phase A: Contract Freeze

成果物:

- schema package の初版
- API contract 文書
- test fixtures

完了条件:

- packet / diagnosis / thin event の schema tests が全通
- mock v3 の必要情報を schema で表現できる

### Phase B: Receiver Core

成果物:

- incident formation
- packet generation
- packet persistence
- read API

完了条件:

- local integration で incident -> packet 保存 -> read が成立
- validation 資産を使った packet generation tests が通る

### Phase C: Diagnosis Worker

成果物:

- GitHub Actions worker logic
- local worker harness
- diagnosis result persistence callback

完了条件:

- local で packet -> diagnosis result -> persistence が通る
- GitHub Actions 用 workflow dry path が定義済み

### Phase D: Console MVP

成果物:

- incident list
- incident detail
- evidence studio
- AI rail

完了条件:

- v3 mock に対して主要情報構成が揃う
- first viewport で `What happened` / `Immediate Action` / `Why this action` が出る
- Evidence Studio interaction tests が通る

### Phase E: Platform Verification

成果物:

- Vercel deploy verification
- Cloudflare deploy verification
- GitHub Actions end-to-end verification

完了条件:

- one incident created on deployed receiver
- one diagnosis completed through Actions
- one result visible in Console
- rollback path exercised at least once in non-production

## Claude Code Work Slicing

Claude Code に渡す単位は大きくしすぎない。

悪い例:

- Receiver を全部作って
- Console を全部作って

良い例:

- packet schema を実装して tests を通す
- diagnosis result schema を実装して tests を通す
- Receiver に `POST /v1/platform-events` を追加して tests を通す
- D1 adapter に shared adapter tests を通す
- Console の incident headline 部分だけを v3 に寄せる

## Model Role Split

Phase 1 の AI 実装では、モデルごとに役割を分ける。

### Codex 5.4

役割:

- 実装計画
- タスク分解
- ADR / contract 整合チェック
- PR 粒度の管理
- repo 横断レビュー

使いどき:

- 何をどう切るか決めるとき
- 複数コンポーネントに跨る設計整合を見るとき
- 実装前に順番を確定するとき

### Sonnet 4.6

役割:

- 実装の主力
- UI 実装
- Receiver 実装
- tests 実装
- CLI / worker 実装

使いどき:

- 契約が固まった後の中規模実装
- 既存コードに沿った機能追加
- テスト追加

### Opus 4.6

役割:

- 難しい設計判断
- diagnosis 品質レビュー
- 仕様の穴や矛盾の発見

使いどき:

- 論点が曖昧なとき
- 重要な設計選択を再評価したいとき
- reasoning / diagnosis の品質を再点検したいとき

## Parallel Development Rules

### Parallelize only after contracts are fixed

並列実装は、以下の契約が固定された後に限る。

- packet schema
- diagnosis result schema
- thin event schema
- Receiver API shape

### Safe parallel workstreams

契約確定後は、以下を並列してよい。

1. `core/contracts`
   - schema
   - validation
   - contract tests
2. `receiver/backend`
   - ingest
   - incident formation
   - packet persistence
   - read APIs
3. `worker/cli`
   - diagnosis runner
   - callback path
   - CLI replay
4. `console/frontend`
   - incident detail UI
   - evidence studio
   - AI rail

### Merge order rule

parallel workstreams を `develop` に統合する順番は固定する。

1. `core/contracts`
2. `receiver/backend`
3. `worker/cli`
4. `console/frontend`

前段の契約を参照する後段 workstream は、前段が `develop` に入るまで最終統合しない。

### Unsafe parallel work

以下は契約未確定のまま並列しない。

- packet schema 未確定で Receiver と Console を同時に進める
- diagnosis result shape 未確定で worker と UI を同時に進める
- ingest 方式未確定で Receiver 実装を始める

## Instructions For Sonnet Planning

Sonnet が実装プランを作るときは、以下に従う。

- 大きな feature 単位ではなく、contract-preserving な小タスクへ分解する
- 先に contract / test / fixture を置く
- 実装と同時に対応する test を置く
- local で担保できるものを先に完了させる
- Vercel / Cloudflare / GitHub Actions の境界面は後段にまとめる
- parallel workstreams は `core / receiver / worker-cli / console` の4本を基本にする
- 依存が未固定の作業は parallel に出さない

## Non-Negotiable Quality Gates

以下を満たさない限り先に進まない。

- schema contract tests が壊れていない
- packet generation が deterministic に再現できる
- diagnosis result が schema を満たす
- Receiver が canonical store として一貫している
- UI が first viewport requirement を壊していない
- GitHub Actions / Vercel / Cloudflare の境界面は少なくとも happy path と failure path を持つ
- local DB-backed tests で Postgres / SQLite 近似の永続化が通っている
- security review 観点で auth / secret handling に未解決が残っていない
- diagnosis review 観点で action / reasoning / evidence に重大矛盾がない
- release candidate は Vercel / Cloudflare / GitHub Actions の boundary smoke を通過している
- performance guardrails について最低限の数値確認が取れている

## Performance Acceptance Targets

Phase 1 では、少なくとも以下を測定対象にする。

- current incident detail first render
  - target: ローカル開発環境で 1s 未満
- Evidence Studio open
  - target: 体感で即時、測定上 300ms 程度以内を目標
- packet stored -> diagnosis visible
  - target: happy path で数分以内、5分 SLA を超えない

これらは厳密な本番 SLA ではなく、Phase 1 の退行検知用 guardrail として扱う。

### Measurement method

#### UI timing

Playwright CLI を使って user-visible behavior と描画タイミングを測定する。

- `current incident detail first render`
  - incident detail 画面を開き、`What happened` と `Immediate Action` が visible になるまでを測る
- `Evidence Studio open`
  - `Open Evidence Studio` click から overlay 内の `Metrics` view が visible になるまでを測る

測定方針:

- Playwright の web-first assertions を使う
- `performance.mark()` / `performance.measure()` で browser timing を取る
- CI では headless Chromium を使う
- threshold を超えたら fail にする

#### Diagnosis path timing

`packet stored -> diagnosis visible` は browser ではなく system event として測る。

- Receiver で packet 保存時刻を記録
- GitHub Actions で diagnosis 開始 / 完了時刻を記録
- Receiver で diagnosis result 保存時刻を記録
- Console API で visible になった最終時刻をローカル integration で検証する

#### Tooling choice

Phase 1 の browser-based UX guardrail には Playwright CLI を使う。  
理由:

- user-visible behavior を基準に測れる
- GitHub Actions 上でそのまま回せる
- trace / HTML report が残る

## Recommended Order Of Execution

1. `packages/core`
   - packet / diagnosis / thin event schema
   - contract tests
2. `apps/receiver`
   - incident formation
   - packet persistence
   - read APIs
3. local diagnosis harness
   - worker logic without GitHub-specific wrapper
4. `packages/cli`
   - replay / diagnose
5. `apps/console`
   - incident detail first
   - evidence studio next
6. GitHub Actions workflow
7. D1 / Vercel Postgres verification
8. Vercel / Cloudflare deploy verification

## Final Standard

Phase 1 MVP は「動いた」で完了しない。  
以下を満たして初めて完了とする。

- architecture contracts are stable
- local integration is trustworthy
- platform boundaries are verified
- UI reflects the chosen mock basis
- diagnosis path feels fast enough to support a 3am workflow
