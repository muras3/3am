# ADR 0021: Receiver and GitHub Actions Integration

- Status: Accepted
- Date: 2026-03-08

## Context

ADR 0015 で Phase 1 の diagnosis runtime は **GitHub Actions を推奨構成**とし、CLI parity を必須とした。  
また ADR 0018 で `incident packet`、ADR 0019 で `diagnosis result`、ADR 0020 で `thin event` の契約が整理された。

ここで残るのは、Receiver と GitHub Actions の責務境界と連携順序を確定することである。

## Decision

Phase 1 の診断連携は、以下の責務分離で実装する。

### Receiver

Receiver は以下を担う。

- raw OTel / platform logs ingest
- incident formation
- `incident packet` 生成
- packet の保存
- thin event の送信
- `diagnosis result` の保存
- Console 向け read API

Receiver は **canonical store** とする。

### GitHub Actions

GitHub Actions は以下を担う。

- thin event を受けて起動する
- `incident_id` / `packet_id` を使って Receiver から packet を取得する
- LLM 診断を実行する
- `diagnosis result` を Receiver に返す

GitHub Actions は **event-driven worker** とし、canonical store にはならない。

## Integration Flow

1. Receiver が incident を作る
2. Receiver が `incident packet` を保存する
3. Receiver が thin event を GitHub Actions に push する
4. GitHub Actions が Receiver API から packet を取得する
5. GitHub Actions が LLM を実行し `diagnosis result` を作る
6. GitHub Actions が Receiver に result を返す
7. Console は Receiver の保存済み incident / packet / result を読む

## Explicit Non-Goals

この構成では、以下を行わない。

- GitHub Actions を event bus として使うこと
- GitHub Actions が DB を直接読むこと
- GitHub Actions が packet 本文を source of truth として保持すること
- Console が GitHub Actions の出力だけに依存すること

## Rationale

- Receiver を canonical store にすると UI と worker の整合が取りやすい
- GitHub Actions は stateless worker として使う方が責務が明確
- packet 本文を thin event から分離することで trigger 契約を安定させられる
- CLI も同じ packet を読む consumer として並行に保てる

## Consequences

- Receiver には packet / result の保存 API と参照 API が必要になる
- GitHub Actions には packet fetch と result callback の実装が必要になる
- diagnosis runtime を他の worker 基盤へ差し替える場合でも、Receiver の canonical store 役割は維持できる

## Related

- [0015-diagnosis-runtime-github-actions-with-cli-parity.md](/Users/murase/project/3amoncall/docs/adr/0015-diagnosis-runtime-github-actions-with-cli-parity.md)
- [0018-incident-packet-semantic-sections.md](/Users/murase/project/3amoncall/docs/adr/0018-incident-packet-semantic-sections.md)
- [0019-diagnosis-result-minimum-contract.md](/Users/murase/project/3amoncall/docs/adr/0019-diagnosis-result-minimum-contract.md)
- [0020-thin-event-contract-for-diagnosis-trigger.md](/Users/murase/project/3amoncall/docs/adr/0020-thin-event-contract-for-diagnosis-trigger.md)
