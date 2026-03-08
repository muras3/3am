# ADR 0020: Thin Event Contract for Diagnosis Trigger

- Status: Accepted
- Date: 2026-03-08

## Context

Receiver が `incident packet` を作った後、GitHub Actions などの diagnosis runtime をどう起動するかを決める必要がある。

`incident packet` 本文をそのままイベント payload として送る案もあるが、Phase 1 の想定では以下の問題がある。

- payload が大きくなりやすい
- 再試行や冪等性の扱いが難しくなる
- packet schema の変更が trigger 契約に直接波及する
- diagnosis runtime が canonical store を持たないまま packet 本文に依存してしまう

一方で、Receiver は `incident packet` を canonical store として保持できる。

## Decision

diagnosis runtime を起動するイベントは **thin event** とする。  
Receiver は `incident packet` 本文を直接送らず、最小限の起動情報だけを GitHub Actions に push する。

### Minimum Contract

```json
{
  "event_id": "evt_123",
  "event_type": "incident.created",
  "incident_id": "inc_123",
  "packet_id": "pkt_123"
}
```

### Field Meaning

- `event_id`
  - イベント自体の識別子
  - 冪等性と再試行判定に使う
- `event_type`
  - 何の診断トリガーかを示す
  - Phase 1 では少なくとも `incident.created` を持つ
- `incident_id`
  - Receiver 側の incident 識別子
- `packet_id`
  - diagnosis runtime が取得すべき packet の識別子

## Explicit Non-Goals

thin event には、以下を含めない。

- packet 本文
- raw observability data
- diagnosis result
- UI 用 summary

## Rationale

- event を薄く保つことで、payload サイズと再送コストを抑えられる
- packet の進化と trigger 契約を分離できる
- GitHub Actions は event bus ではなく **event-driven worker** として使う方が筋が良い
- Receiver を canonical store のまま維持できる

## Consequences

- GitHub Actions は thin event を受け取った後、Receiver から `packet_id` に対応する packet を取得する必要がある
- Receiver は packet を保存しておく必要がある
- diagnosis runtime の trigger 契約は安定しやすくなる
- 将来的に worker の実行基盤を GitHub Actions 以外へ差し替えても、thin event 契約は流用しやすい

## Related

- [0015-diagnosis-runtime-github-actions-with-cli-parity.md](/Users/murase/project/3amoncall/docs/adr/0015-diagnosis-runtime-github-actions-with-cli-parity.md)
- [0018-incident-packet-semantic-sections.md](/Users/murase/project/3amoncall/docs/adr/0018-incident-packet-semantic-sections.md)
- [0019-diagnosis-result-minimum-contract.md](/Users/murase/project/3amoncall/docs/adr/0019-diagnosis-result-minimum-contract.md)
