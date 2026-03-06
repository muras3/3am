# ADR 0003: First Scenario Is Rate Limit Cascade

- Status: Accepted
- Date: 2026-03-06

## Context

最初の検証シナリオは 1 本に絞る必要がある。候補には `db_migration_lock_contention`、`upstream_cdn_stale_cache_poison`、`secrets_rotation_partial_propagation` などがあるが、最初の実装で複雑さを持ち込みすぎると、fixture 設計と診断の失敗原因を切り分けにくい。

## Decision

最初のシナリオは `third_party_api_rate_limit_cascade` にする。

シナリオの中核は以下とする。

- flash sale によるトラフィック急増
- 支払い依存先の 429
- fixed retry による retry storm
- shared worker pool の枯渇
- queue depth の増加
- orchestrated routes 全体への 504 波及

最初のスタックには PostgreSQL も含めるが、目的は主因ではなく red herring と将来シナリオの布石である。

## Consequences

- 最初の `web` は固定サイズ concurrency pool を持つ
- `mock-stripe` は管理 API による deterministic な mode 切り替えを持つ
- `loadgen` は `baseline -> flash_sale` の切り替えを API で受ける
- PostgreSQL は自然な `db_connection_count` ノイズ生成と将来の `db_migration_lock_contention` への再利用に使う

## Related

- [validation-mvp-v0.1.md](/Users/murase/project/3amoncall/docs/validation-mvp-v0.1.md)
- [local-validation-stack-v0.1.md](/Users/murase/project/3amoncall/docs/local-validation-stack-v0.1.md)
- [compose-and-scenario-draft-v0.1.md](/Users/murase/project/3amoncall/docs/compose-and-scenario-draft-v0.1.md)
