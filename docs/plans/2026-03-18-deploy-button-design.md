# Deploy Button + npx 3amoncall init 設計

Date: 2026-03-18
Status: Approved

## ゴール

3amoncall のセルフホスト導入を「ローカル5分体験 → 1-click 本番デプロイ」にする。

## ユーザー体験フロー

### Phase 0: ローカルで試す (5分)

```
$ cd my-app
$ npx 3amoncall init
  ✔ Detected: Next.js (package.json)
  ✔ Package manager: pnpm
  ✔ Installing @opentelemetry/sdk-node, @opentelemetry/auto-instrumentations-node, @opentelemetry/exporter-trace-otlp-http
  ✔ Generated instrumentation.ts
  ✔ Added OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3333/v1 to .env
  ✔ Added OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer dev-token" to .env
  Done! Run `npx 3amoncall dev` to start the local receiver.

$ npx 3amoncall dev
  ✔ Receiver running at http://localhost:3333
  ✔ Console at http://localhost:3333
  ✔ Using MemoryAdapter (data resets on restart)
  ✔ ANTHROPIC_API_KEY loaded from .env
  Waiting for OTel data...

$ pnpm dev  # ユーザーのアプリ起動
  → OTel データが localhost:3333 に流れる
  → インシデント検知 → 自動診断 → Console で確認
```

### Phase 1: 本番デプロイ (Deploy Button)

```
README の "Deploy to Vercel" ボタンをクリック
  → GitHub にフォーク
  → Vercel デプロイ画面:
    - ANTHROPIC_API_KEY: [ユーザーが貼る] (唯一の手動入力)
    - RECEIVER_AUTH_TOKEN: (自動生成)
    - DATABASE_URL: (Neon Marketplace 自動プロビジョン)
  → デプロイ完了: https://<user>.vercel.app

$ npx 3amoncall init --upgrade
  ? Receiver URL: https://<user>.vercel.app
  ? AUTH_TOKEN: (Vercel Dashboard からコピー)
  ✔ Updated .env: OTEL_EXPORTER_OTLP_ENDPOINT=https://<user>.vercel.app/v1
  ✔ Updated .env: OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <token>"
  Done! Deploy your app and OTel data will flow to production.
```

## アーキテクチャ

### 変更前 (v0.2)

```
App → OTel → Receiver (no LLM key) → thin event → GitHub Actions (LLM key) → diagnosis → Receiver → Console
```

### 変更後 (ADR 0034)

```
App → OTel → Receiver (LLM key あり) → 異常検知 → 直接診断 → DB 保存 → Console
```

### 環境変数

| 変数 | ローカル | Vercel (Deploy Button) |
|------|---------|----------------------|
| ANTHROPIC_API_KEY | .env (ユーザー手動) | Deploy Button フォームで入力 |
| RECEIVER_AUTH_TOKEN | "dev-token" (固定) | generateValue: "secret" (自動生成) |
| DATABASE_URL | なし (MemoryAdapter) | Neon Marketplace (自動プロビジョン) |
| ALLOW_INSECURE_DEV_MODE | true | なし |

## deploy.json

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": null,
  "buildCommand": "pnpm turbo run build",
  "installCommand": "pnpm install",
  "outputDirectory": "apps/console/dist",
  "env": {
    "ANTHROPIC_API_KEY": {
      "description": "Anthropic API key for LLM diagnosis (get at console.anthropic.com)",
      "required": true
    },
    "RECEIVER_AUTH_TOKEN": {
      "description": "Bearer token for OTel SDK authentication (auto-generated)",
      "generateValue": "secret"
    }
  },
  "integrations": [
    {
      "id": "neon",
      "options": {
        "DATABASE_URL": "DATABASE_URL"
      }
    }
  ]
}
```

## npx 3amoncall init — 技術設計

### サブコマンド構成

```
3amoncall init          # OTel SDK セットアップ (ユーザーのアプリ)
3amoncall init --upgrade  # ローカル → 本番 URL 切り替え
3amoncall dev           # ローカル Receiver 起動
3amoncall-cli --packet  # 既存: ローカル診断 (変更なし)
```

### フレームワーク検出

package.json の dependencies/devDependencies をチェック:

| 検出対象 | dep 名 | instrumentation.ts テンプレート |
|---------|--------|-------------------------------|
| Next.js | `next` | `instrumentation.ts` with `register()` export |
| Express | `express` | `instrumentation.ts` + `--import` flag 案内 |
| Generic Node.js | (fallback) | `instrumentation.ts` + `--import` flag 案内 |

### パッケージマネージャ検出

| lock file | マネージャ | install コマンド |
|-----------|-----------|-----------------|
| pnpm-lock.yaml | pnpm | pnpm add |
| yarn.lock | yarn | yarn add |
| package-lock.json | npm | npm install |
| bun.lockb | bun | bun add |

### インストールする deps

```
@opentelemetry/sdk-node
@opentelemetry/auto-instrumentations-node
@opentelemetry/exporter-trace-otlp-http
```

### 生成ファイル: instrumentation.ts (Next.js)

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    headers: Object.fromEntries(
      (process.env.OTEL_EXPORTER_OTLP_HEADERS || '').split(',').map(h => h.split('='))
    ),
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
```

### .env 追記

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3333/v1
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer dev-token"
```

## npx 3amoncall dev — 技術設計

- `createApp()` を MemoryAdapter で起動
- `@hono/node-server` で listen (デフォルト port 3333)
- `ANTHROPIC_API_KEY` を `.env` から読む (dotenv)
- Console SPA は `apps/console/dist` から serve (ビルド済み前提、なければ警告)
- ALLOW_INSECURE_DEV_MODE=true (CORS 緩和、auth スキップ)

## セキュリティ

- ADR 0034 参照: credential separation 廃止の根拠とリスク分析
- Vercel Firewall rate limiting を推奨設定としてドキュメント化
- README に Anthropic spending limit 設定の推奨を記載

## 3月スコープ

### やる

- deploy.json + Deploy Button (Vercel)
- npx 3amoncall init (Next.js / Express / generic Node.js)
- npx 3amoncall dev (ローカル Receiver)
- npx 3amoncall init --upgrade (ローカル → 本番切り替え)
- Receiver 内診断 (diagnose() 直接呼び出し)
- README Getting Started

### やらない

- Cloudflare 対応 (後追い、Terraform/IaC)
- Hono / Fastify 等の追加フレームワーク対応
- Docker Compose ベースのローカル環境
- product-concept-v0.3 の全面書き直し
- 課金保護の自動化

## 廃止するもの

- thin event の外部通知用途 (ThinEventSchema 自体は core に残す)
- GitHub Actions を診断ランタイムとする設計
- credential separation (ADR 0015 の一部を supersede)

## 次のステップ

この設計を implementation plan に分解する (writing-plans skill)。
