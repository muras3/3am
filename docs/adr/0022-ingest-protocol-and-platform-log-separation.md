# ADR 0022: Ingest Protocol and Platform Log Separation

- Status: Accepted
- Date: 2026-03-08

## Context

Phase 1 の Receiver は、app observability data と platform-side facts の両方を受け取る必要がある。  
一方で、この 2 つは性質が異なる。

- traces / metrics / logs は OTel SDK から自然に送られる
- platform logs / deploy / config / traffic mode などは OTel そのものではない場合がある

このため、ingest は UX ではなく **技術的合理性** を優先して決めるべきである。

## Decision

Phase 1 の ingest は以下とする。

### App observability ingest

traces / metrics / logs は **OTLP/HTTP** を正規 ingest とする。

- first-class transport: `protobuf`
- optional fallback / dev / replay: `json`

Receiver は少なくとも以下を受ける。

- `POST /v1/traces`
- `POST /v1/metrics`
- `POST /v1/logs`

### Platform log ingest

`platform logs` は OTLP に無理に載せず、**別 ingest** とする。

例:

- `POST /v1/platform-events`

ここには以下のような platform-side facts を送る。

- deploy
- config change
- routing / traffic mode
- provider event

### Internal handling

Receiver は ingest 層では app observability と platform logs を分離しつつ、  
incident formation と packet generation の前に同一 incident 文脈へ統合する。

## Rationale

- OTel SDK から自然に送れる経路をそのまま使う方が実装と導入が簡単
- `OTLP/HTTP protobuf` はサイズ・処理効率・互換性の面で本番向き
- `json` は便利だが、正規 transport にすると protocol 境界が緩みやすい
- platform logs は量が少なく、意味も app telemetry と異なるため、別 ingest の方が自然
- ingest を分離しても incident packet で統合すれば、UI と diagnosis の体験は壊れない

## Explicit Non-Goals

Phase 1 では、以下を行わない。

- platform logs を無理に OTel schema に寄せること
- custom ingest format を traces / metrics / logs の正規形式にすること
- ingest 層で diagnosis-ready summary を生成すること

## Consequences

- app observability は OTel 標準に沿って受けられる
- platform logs は別 endpoint で扱う必要がある
- incident packet generation の直前で両者を統合する正規化層が必要になる
- CLI / replay では OTLP JSON を補助入力として扱える余地を残せる

## Related

- [0016-incident-packet-v1alpha.md](/Users/murase/project/3amoncall/docs/adr/0016-incident-packet-v1alpha.md)
- [0018-incident-packet-semantic-sections.md](/Users/murase/project/3amoncall/docs/adr/0018-incident-packet-semantic-sections.md)
- [0021-receiver-and-github-actions-integration.md](/Users/murase/project/3amoncall/docs/adr/0021-receiver-and-github-actions-integration.md)
