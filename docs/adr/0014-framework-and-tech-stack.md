# ADR 0014: Framework and Tech Stack

- Status: Accepted
- Date: 2026-03-07

## Context

Phase 1（Receiver + Console）の実装に向けて、言語・フレームワークを決定する必要がある。

要件：
- **クロスプラットフォーム**：Cloudflare Workers と Vercel の両方にデプロイできる
- **ロックインなし**：将来的に AWS Lambda / Bun / Railway / Fly への拡張が可能
- **軽量・高速**：もっさりしたものは避ける
- **モダン**：最新の技術スタックを優先する
- **OSS**：セットアップ体験がシンプルであること

検討した選択肢：

**言語**：TypeScript vs Rust+WASM
- Rust+WASM は `workers-rs` で CF Workers 対応可能だが、Vercel Rust は Beta、クロスプラットフォーム対応が断片的
- ネットワークバウンドなワークロードで Rust の性能優位は出ない
- CF Workers は V8 isolate（TypeScript ネイティブ）
- Codex (gpt-5.4) も同じ結論：TypeScript 一択

**Receiver フレームワーク**：Hono vs TanStack Start vs Elysia vs Fastify
- Elysia：CF Workers アダプターが `experimental` → 失格
- Fastify：自社ドキュメントでサーバーレス非推奨 → 失格
- TanStack Start：React メタフレームワーク。UI ゼロの純 API サーバーに使うのは antipattern。CF Workers での env bindings 未取得バグ・本番で server function が動かないバグが報告済み（RC 段階）
- Hono：Edge-first、Web 標準 API、CF Workers ネイティブ、Vercel/AWS Lambda/Bun/Node アダプター完備

**Console フレームワーク**：TanStack Start vs React + Vite
- TanStack Start は CF Workers の Cloudflare vite-plugin 互換性問題が未解決（2025年時点）
- React 19.2 + Vite 7 は安定、どこにでもデプロイ可能な SPA

Codex (gpt-5.4) に2回相談し、いずれも同じ結論に至った。

## Decision

### 言語

**TypeScript**（全コンポーネント共通）

### フレームワーク・ライブラリ

| コンポーネント | 選択 | 備考 |
|-------------|------|------|
| Receiver | Hono | 純 API サーバー。CF Workers / Vercel 両対応 |
| Console API | Hono | Receiver と同一スタック |
| Console UI | React 19.2 + Vite 7 | SPA。Hono が静的配信 |
| Console UI ルーティング | TanStack Router | React 内ライブラリとして使用 |
| Console UI データフェッチ | TanStack Query | React 内ライブラリとして使用 |
| モノレポ | Turborepo | TypeScript OSS モノレポの現代的標準 |

TanStack Start（メタフレームワーク）は使用しない。TanStack の恩恵は Router + Query として Console フロントエンド内で受ける。

### レイヤー構造（Receiver）

```
Domain（純粋な TypeScript、フレームワーク import なし）
  ↓
Transport（Hono routes / middleware）
  ↓
Runtime（CF Workers adapter / Vercel adapter — 薄い shim のみ）
  ↓
Storage（StorageDriver — ADR0013 で決定済み）
```

## Rationale

- **Hono が唯一「Edge ファースト × クロスプラットフォーム × 軽量」を満たす**：14KB、Web 標準 API、CF Workers ネイティブ、Vercel/Lambda/Bun/Node アダプター完備
- **TanStack Start を Receiver に使うのは antipattern**：純 API サーバーに React SSR 機構を持ち込む理由がない
- **TanStack Start の CF Workers 対応は RC 段階で不安定**：本番で env bindings が取れないバグ、server function が失敗するバグが報告済み
- **React + Vite はモダンかつ安定**：SPA として静的ファイルにビルドされるため、どのプラットフォームでも配信可能
- **TanStack Router + Query で最新性を確保**：Console UI 内で型安全ルーティング・データフェッチを実現

## Consequences

- Receiver と Console API は同一スタック（Hono）のため、共通ミドルウェア・型定義を monorepo 内で共有できる
- Console UI は SPA のため、Hono が静的ファイルを配信する構成になる
- TanStack Start が v1 安定版になり CF Workers 対応が成熟した時点で、Console への採用を再検討できる
- 将来の AWS Lambda / Bun / Railway / Fly への拡張は Hono のアダプターを追加するだけで対応可能
