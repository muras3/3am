# ADR 0024: Storage Implementation With Drizzle

- Status: Accepted
- Date: 2026-03-08

## Context

ADR 0013 で `StorageDriver` インターフェースと、Cloudflare D1 / Vercel Postgres を使う方針は決まっている。  
残る論点は、その上をどのデータアクセス層で実装するかである。

Phase 1 の条件は以下である。

- TypeScript
- small team
- edge / serverless
- Cloudflare D1 と Postgres の両対応
- schema / query / migration が人間にも AI にも追いやすいこと

## Decision

Phase 1 の storage 実装は **Drizzle** を中心に構成する。

具体方針は以下とする。

- `StorageDriver` を公開 abstraction とする
- driver 内部では Drizzle schema と typed query を使う
- migration も Drizzle ベースで管理する
- heavy ORM 的な隠蔽は避け、薄い typed access layer として使う

## Rationale

- Drizzle は TypeScript で schema が明示的に見える
- SQLite 系（D1）と Postgres 系の両方に比較的素直に対応できる
- SQL に近く、query の挙動を追いやすい
- hidden magic が少なく、AI 時代の explicit / inspectable な実装に向く
- `StorageDriver` の背後に置くには十分に軽量である

## Explicit Non-Goals

Phase 1 では、以下を目指さない。

- 重厚な ORM による完全抽象化
- DB 製品差分の完全消去
- ORM を公開 API にすること

`StorageDriver` が public abstraction であり、Drizzle は内部実装である。

## Consequences

- schema と migration の source of truth は Drizzle 側に寄る
- D1 / Postgres の差分は driver 実装で吸収する
- query の明示性と追跡性が上がる
- 今後 local SQLite や別 adapter を足す場合も Drizzle ベースで拡張しやすい

## Related

- [0013-cross-platform-storage-driver.md](/Users/murase/project/3amoncall/docs/adr/0013-cross-platform-storage-driver.md)
- [0021-receiver-and-github-actions-integration.md](/Users/murase/project/3amoncall/docs/adr/0021-receiver-and-github-actions-integration.md)
