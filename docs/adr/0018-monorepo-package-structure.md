# ADR 0018: Monorepo Package Structure

- Status: Draft
- Date: 2026-03-08

## Context

ADR 0014 で Turborepo モノレポ + TypeScript の採用が決まった。
Phase 1 の実装を開始するにあたり、`apps/` と `packages/` の分割ルールを明文化する必要がある。

設計に影響する既存の決定事項：

| ADR | 内容 |
|-----|------|
| 0013 | StorageDriver 抽象化（CF D1 / Vercel Postgres） |
| 0012 | Phase 1 では `@3amoncall/otel` を作らない。Phase 2 で必須 |
| 0014 | Turborepo + Hono（Receiver + Console API）+ React 19.2 + Vite 7 |
| 0015 | CLI は正式な consumer（npm 公開前提） |
| 0016 | incident packet schema は Receiver・Console・CLI の全コンポーネントが共有 |

## Decision

### ディレクトリ構成

```
apps/
  receiver/           ← Hono バックエンド（OTLP / 異常検知 / packetizer / console API）
  console/            ← React + Vite SPA（receiver:bundle に組み込まれ一体デプロイ）

packages/
  core/               ← @3amoncall/core（npm 公開）
  diagnosis/          ← @3amoncall/diagnosis（npm 公開）
  cli/                ← @3amoncall/cli（npm 公開）
  config-typescript/  ← 共有 tsconfig（非公開）
  config-eslint/      ← 共有 eslint config（非公開）
```

StorageDriver は `apps/receiver` 内の `storage/` 層に置く（後述）。

### 各パッケージの責務

#### `apps/receiver` + `apps/console`（Deploy Button 対象は両者の合成成果物 `receiver:bundle`）

`apps/receiver` は Hono バックエンド（OTLP ingest・異常検知・packetization・Console API・console UI の静的配信）。
`apps/console` は React + Vite SPA で、ビルド後の `dist/` が `receiver:bundle` に取り込まれる。
Deploy Button でデプロイされるのは `receiver:bundle` であり、receiver と console の両方が含まれる。CF Workers および Vercel の両プラットフォームに対応。

ADR 0014 が定めるレイヤー構造に従う：

```
Domain（純粋 TypeScript。フレームワーク import なし）
  ↓
Transport（Hono routes / middleware）
  ↓
Runtime（CF Workers adapter / Vercel adapter）
  ↓
Storage（receiver 内の storage/ 層）
```

StorageDriver は `apps/receiver` だけが使うため、独立パッケージにせず receiver 内に収める。

```
apps/receiver/src/
  domain/             ← 異常検知・packetizer・formation
  transport/          ← Hono routes
  storage/            ← StorageDriver interface + adapters
    interface.ts
    adapters/
      cloudflare.ts   ← CF D1
      vercel.ts       ← Vercel Postgres / Neon
      memory.ts       ← ローカル開発・テスト用
  index.ts
```

CF Workers ビルドへの Node/Postgres コード混入はバンドラー設定（`wrangler.toml` の `external` / Vite の `ssr.external`）で制御する。

#### `apps/console`

React 19.2 + Vite 7 の SPA。ビルド成果物（`dist/`）は `apps/receiver` が静的配信する。
ADR 0014 の「1つの Hono アプリとして一体デプロイ」を実現するための分離。

#### `packages/core`（npm 公開: `@3amoncall/core`）

Receiver・Console・CLI が共有する契約パッケージ。

- incident packet の Zod schema（ADR 0016）
- incident formation の型定義（ADR 0017）
- DiagnosisResult schema
- 共通 TypeScript 型

フレームワーク import なし。純粋な TypeScript のみ。

#### `packages/diagnosis`（npm 公開: `@3amoncall/diagnosis`）

LLM 診断エンジン本体。`packages/core` の incident packet を受け取り、v5 プロンプトで診断結果を返す。

- `diagnose(packet: IncidentPacket, options: DiagnoseOptions): Promise<DiagnosisResult>`
- フレームワーク・CLI フレームワーク import なし。純粋な TypeScript + Anthropic SDK のみ

GitHub Actions や将来の hosted runtime はこのパッケージを直接 import できる。

#### `packages/cli`（npm 公開: `@3amoncall/cli`）

`packages/diagnosis` の薄いラッパー。CLI インターフェースの提供のみを担う（ADR 0015）。

- `diagnose <packet.json>` — `@3amoncall/diagnosis` を呼び出して結果を出力
- `replay <packet.json>` — 過去 packet の再診断（開発・検証用）

GitHub Actions は `npx @3amoncall/cli diagnose` をシェルアウトで呼ぶ。

#### `packages/config-typescript` / `packages/config-eslint`（非公開）

Turborepo 標準の共有設定パッケージ。全パッケージで tsconfig / eslint を統一する。

### Turborepo ビルドパイプライン

```
core:build
  └→ diagnosis:build
       └→ cli:build
  └→ console:build ──┐
  └→ receiver:build ─┴→ receiver:bundle（デプロイ成果物）
```

`receiver:build` はバックエンドのコンパイルのみを行う。`console:build` の出力との組み合わせは `receiver:bundle` が担う。これによりバックエンド変更時にフロントエンドのビルドを再実行せずに済み、CI キャッシュ効率が向上する。

### npm 公開パッケージ

| パッケージ名 | 対象 | 公開フェーズ |
|-------------|------|------------|
| `@3amoncall/core` | schema・型定義 | Phase 1 |
| `@3amoncall/diagnosis` | LLM 診断エンジン | Phase 1 |
| `@3amoncall/cli` | CLI（diagnosis の薄いラッパー） | Phase 1 |
| `@3amoncall/otel` | OTel wrapper | Phase 2（ADR 0012） |

## Rationale

- **`apps/` = デプロイ対象、`packages/` = 共有ライブラリ** は Turborepo の標準パターンであり、OSS リポジトリでも広く採用されている（cal.com, trigger.dev 等）
- `apps/receiver` と `apps/console` を分離することで、UI の開発が Vite dev server で独立して行える。一体デプロイ（ADR 0014）と矛盾しない
- `packages/core` を独立させることで、packet schema の変更が全コンポーネントに型安全に伝播する
- StorageDriver は `apps/receiver` だけが使うため、独立パッケージにする理由がない。receiver 内の `storage/` 層に収めることでパッケージ数を最小化する
- 異常検知・packetization・StorageDriver のドメインロジックは Phase 1 では `apps/receiver` の各層に置く。独立パッケージへの抽出は実データで設計が安定してから検討する

## Consequences

- `receiver:build`（バックエンドコンパイル）と `receiver:bundle`（デプロイ成果物）を分離したことで、バックエンド変更時に `console:build` を再実行しなくて済む
- `@3amoncall/core` を公開することで、サードパーティが独自の診断ランタイムや Console を実装できる拡張性が生まれる
- ローカル開発時は `InMemoryAdapter`（`apps/receiver/src/storage/adapters/memory.ts`）を使うことで、CF D1 / Vercel Postgres なしに動作確認できる

## Related

- [0012-otel-wrapper-phase.md](0012-otel-wrapper-phase.md)
- [0013-cross-platform-storage-driver.md](0013-cross-platform-storage-driver.md)
- [0014-framework-and-tech-stack.md](0014-framework-and-tech-stack.md)
- [0015-diagnosis-runtime-github-actions-with-cli-parity.md](0015-diagnosis-runtime-github-actions-with-cli-parity.md)
- [0016-incident-packet-v1alpha.md](0016-incident-packet-v1alpha.md)
