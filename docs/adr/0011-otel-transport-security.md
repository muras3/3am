# ADR 0011: OTel Transport Security — HTTPS + Bearer Token

- Status: Accepted
- Date: 2026-03-07

## Context

App（Vercel / Cloudflare Workers）から Receiver の OTLP エンドポイントへ OTel データを送信する際、通信経路をどう保護するかを決める必要がある。

AWS PrivateLink のようなプライベートネットワーク経由の通信が理想だが、プラットフォームの制約がある：

- **Cloudflare Workers**: Service Bindings により Worker 間をプライベート通信できる
- **Vercel**: Vercel → Vercel のプライベートルーティング機能はない（Vercel Secure Compute は外部 VPC 向けであり Vercel 間通信には使えない）

## Decision

**HTTPS + Bearer Token** を標準の通信保護方式として採用する。

- 通信は HTTPS（TLS）で暗号化する
- Receiver の OTLP エンドポイントは Bearer Token による認証を要求する
- App 側は OTel SDK の標準ヘッダー設定でトークンを付与する

```
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>
```

Receiver はトークン不一致・未提示のリクエストを 401 で拒否する。

Cloudflare Workers 環境では、将来的に Service Bindings によるプライベート通信への切り替えを検討できるが、MVP では統一方式として HTTPS + Bearer Token を採用する。

## Rationale

- Datadog・Honeycomb・New Relic など既存の OTel バックエンドがすべて同モデルを採用しており、業界標準として実績がある
- OTLP プロトコル自体がパブリックエンドポイント + 認証ヘッダーの構成を前提に設計されている
- Vercel 固有のプライベートルーティング手段が存在しないため、プラットフォーム横断で統一できる唯一の実用的な選択肢

## Consequences

- Receiver の OTLP エンドポイントはパブリックインターネットに露出する（ただし認証なしでは拒否される）
- AWS PrivateLink 相当のネットワーク分離は達成できない
- トークンの漏洩リスクは App 側の環境変数管理に依存する
