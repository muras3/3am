# ADR 0023: Instrumentation Minimum Requirements

- Status: Accepted
- Date: 2026-03-08

## Context

Phase 1 では、個人開発者や小規模チームが Claude Code などを使って現実的に導入できることが重要である。  
一方で、OTel を「送ってくれれば何でもよい」とすると、incident formation・diagnosis・Console の品質が安定しない。

したがって、Phase 1 で 3amoncall が実用的に動くための **instrumentation minimum requirements** を決める必要がある。

## Decision

Phase 1 では、以下を `required` とする。

### Required

- `service.name`
- `deployment.environment.name` または同等の environment 識別子
- `http.route` または同等の route 識別子
- `http.response.status_code`
- `span.status`
- request / span duration
- `trace_id`
- `span_id`
- external dependency identifier
  - 例: `peer.service` または同等の独自 attr

### Strongly Recommended

- `deployment.id` または `release.version`

### Recommended When Available

- shared resource identifier
  - 例: worker pool 名、queue 名
- platform facts via separate ingest
  - deploy
  - config change
  - traffic mode
  - provider event

## Rationale

- `service.name` がないと incident の主語が定まらない
- environment 識別子がないと incident 境界が壊れる
- route がないと `/checkout` のような impact surface を特定できない
- `http.response.status_code`, `span.status`, duration は Phase 1 anomaly detection の中核
- `trace_id` / `span_id` がないと logs / traces / metrics の相関が弱くなる
- dependency identifier がないと外部依存起因か内部資源起因かの切り分けが難しい
- `deployment.id` があると rollout 起因の切り分け精度が大きく上がる

## Explicit Non-Goals

Phase 1 では、以下を必須にしない。

- 完全な service graph
- すべての infra metadata
- 大量の custom business metrics
- runbook / knowledge injection

## Consequences

- Phase 1 の導入要件は現実的な最小ラインに抑えられる
- この最小ラインだけでも incident formation と diagnosis は成立する
- ただし `deployment.id` や shared resource attr がない場合、diagnosis の確信度と切り分け力は弱くなる
- 今後ラッパーパッケージを作る場合、この ADR が最低限自動付与すべき項目の基準になる

## Related

- [0022-ingest-protocol-and-platform-log-separation.md](/Users/murase/project/3amoncall/docs/adr/0022-ingest-protocol-and-platform-log-separation.md)
- [0018-incident-packet-semantic-sections.md](/Users/murase/project/3amoncall/docs/adr/0018-incident-packet-semantic-sections.md)
- [0019-diagnosis-result-minimum-contract.md](/Users/murase/project/3amoncall/docs/adr/0019-diagnosis-result-minimum-contract.md)
