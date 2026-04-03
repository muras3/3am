# ADR 0016: Incident Packet v1alpha

- Status: Accepted
- Date: 2026-03-08

## Context

ADR 0007 と ADR 0008 で、Receiver が LLM を使わずに `incident packet` を生成する方針は決まっている。  
しかし Phase 1 実装を進めるには、更新前提でもよいので参照用の packet 仕様が必要である。

現時点で重要なのは、完成版 schema を固定することではなく、以下を満たす最小形を置くことである。

- Receiver 実装を進められる
- Incident Console と診断ランタイムが同じ packet を共有できる
- packet が不十分でも raw data に戻れる

## Decision

Phase 1 では、`incident packet` を **v1alpha** として定義する。  
この schema は更新を前提とし、安定 API とは見なさない。

### 入力源

`incident packet` は、以下の raw observability inputs から生成する。

- `OTel traces`
- `OTel logs`
- `OTel metrics`
- `platform logs`

つまり、packet は **OTel 3 種類 + platform logs** を incident 単位に束ね直した evidence bundle である。

### 設計原則

- packet は `summary` ではなく **incident-scoped evidence bundle** とする
- raw ingest format を packet format で置き換えない
- packet から raw artifact へ戻れる pointer を必ず持つ
- LLM による解釈を前提にしない
- narrative は最小限に留め、evidence を主とする

### v1alpha の最小構成

```json
{
  "schemaVersion": "incident-packet/v1alpha1",
  "packetId": "pkt_xxx",
  "incidentId": "inc_xxx",
  "openedAt": "2026-03-08T00:00:00Z",
  "window": {
    "start": "2026-03-08T00:00:00Z",
    "detect": "2026-03-08T00:01:10Z",
    "end": "2026-03-08T00:08:00Z"
  },
  "scope": {
    "environment": "production",
    "primaryService": "web",
    "affectedServices": ["web"],
    "affectedRoutes": ["/checkout"],
    "affectedDependencies": ["stripe"]
  },
  "triggerSignals": [
    {
      "signal": "span_error_rate",
      "firstSeenAt": "2026-03-08T00:01:10Z",
      "entity": "web"
    }
  ],
  "evidence": {
    "changedMetrics": [],
    "representativeTraces": [],
    "relevantLogs": [],
    "platformEvents": []
  },
  "pointers": {
    "traceRefs": [],
    "logRefs": [],
    "metricRefs": [],
    "platformLogRefs": []
  }
}
```

### 非目標

v1alpha では、以下は固定しない。

- field の最終命名
- evidence 選定アルゴリズム
- problem grouping の閾値
- Console 表示用の完成 UI モデル
- 外部公開 API としての長期互換性

## Rationale

- packet がないと、Receiver・Console・diagnosis runtime の契約面が曖昧なままになる
- raw OTel 全量は incident 単位の入力として粗すぎる
- v1alpha と明示すれば、実装で学びながら schema を更新できる
- raw pointer を残すことで、packet の誤りを後から追跡できる

## Consequences

- packet schema は Phase 1 中に変更されることを前提とする
- packetizer の品質が Console と診断品質の両方に影響する
- raw ingest と packet の 2 層を意識した実装が必要になる

## Related

- [0005-raw-evaluation-inputs.md](/Users/murase/project/3am/docs/adr/0005-raw-evaluation-inputs.md)
- [0007-incident-packet-generated-in-receiver.md](/Users/murase/project/3am/docs/adr/0007-incident-packet-generated-in-receiver.md)
- [0008-problem-grouping-and-packetization-without-llm.md](/Users/murase/project/3am/docs/adr/0008-problem-grouping-and-packetization-without-llm.md)
