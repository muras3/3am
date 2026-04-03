# ADR 0005: Evaluate Diagnosis Using Raw Observability Inputs

- Status: Accepted
- Date: 2026-03-06

## Context

validation harness では run ごとに次の 3 層のデータが生成される。

- 観測データ
  - `otel_traces.json`
  - `otel_logs.json`
  - `otel_metrics.json`
  - `platform_logs.json`
- 中間加工データ
  - `summary.json`
  - `events.json`
- 正解データ
  - `ground_truth.json`

`summary.json` は incident packaging や heuristic を含むため、これを診断入力に使うと「診断器」ではなく「要約器」を評価してしまう。  
`ground_truth.json` を使うのは当然不可である。

一方で、現状の collector file exporter 出力は run ごとにそのままでは読みづらく、NUL 除去や JSON array 化を行った `normalized raw OTel artifacts` を run artifact として保存している。

## Decision

3am の診断評価は、原則として次の raw input だけを使って行う。

- `otel_traces.json`
- `otel_logs.json`
- `otel_metrics.json`
- `platform_logs.json`

`summary.json` と `ground_truth.json` は診断入力として使わない。

現時点では collector 一次出力そのものではなく、record の意味を変えない範囲で serialization を整えた `normalized raw OTel artifacts` を raw input と見なす。

## Consequences

- 診断評価と incident packaging の評価を分離できる
- `summary.json` を使った高速反復は開発補助としては許容されるが、正式評価には使えない
- raw input の厳密性にはまだ改善余地があるため、将来的には collector 一次出力をそのまま正本に近づける必要がある
- run artifact の品質不備は診断器の失敗ではなく harness 側の問題として扱う

## Related

- [validation-mvp-v0.1.md](/Users/murase/project/3am/docs/validation-mvp-v0.1.md)
- [0004-ground-truth-schema-compatibility.md](/Users/murase/project/3am/docs/adr/0004-ground-truth-schema-compatibility.md)
