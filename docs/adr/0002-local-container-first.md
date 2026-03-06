# ADR 0002: Local Container First

- Status: Accepted
- Date: 2026-03-06

## Context

検証MVPでは、同じ障害シナリオを何度も再現し、毎回同じ形式で traces / logs / metrics / 補助イベントを回収する必要がある。

最初から Vercel / Cloudflare の実環境に寄せると、次の問題が出る。

- プラットフォーム差分と診断ロジックの問題を切り分けにくい
- 試行コストと実行時間が増える
- 依存サービスや fault injection の制御がしにくい

## Decision

検証MVPは `docker compose` を前提にしたローカルコンテナ環境から始める。

最初の環境では以下を優先する。

- 再現性
- 実行速度
- fault injection の制御容易性
- OTel artifact の安定回収

Vercel / Cloudflare 固有の挙動は第2段階で検証する。

## Consequences

- 最初の実装は本番用ではなく、障害再現ハーネスとなる
- `edge cache` や `deployment skew` のような固有現象は後回しになる
- 検証が安定した後に、重要シナリオだけ platform-specific に移植する

## Related

- [local-validation-stack-v0.1.md](/Users/murase/project/3amoncall/docs/local-validation-stack-v0.1.md)
- [compose-and-scenario-draft-v0.1.md](/Users/murase/project/3amoncall/docs/compose-and-scenario-draft-v0.1.md)
