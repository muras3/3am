# ADR 0004: Ground Truth Schema Compatibility

- Status: Accepted
- Date: 2026-03-06

## Context

検証 fixture は 3amoncall 内部の資料で完結するだけでなく、`probe-investigate` 側の評価パイプラインにも将来的に接続したい。

一方で、`probe-investigate` の `scenario.schema.json` は厳密であり、`ground_truth` に任意の拡張フィールドを直接追加すると schema validation に失敗する。

また、検証で必要な情報には 2 種類ある。

- probe-investigate 互換の必須 ground truth
- 3amoncall の検証で使う追加情報

## Decision

`ground_truth.template.json` を ground truth の正本にする。  
`scenario.yaml` 内の `ground_truth` は参照用サマリに限定する。

追加の検証情報は `validation_extensions` に隔離する。

### probe-investigate 互換で保持する項目

- `primary_root_cause`
- `contributing_root_causes`
- `detail`
- `recommended_actions`
- `t_first_symptom_oracle`

### validation_extensions に保持する項目

- `trigger`
- `causal_chain`
- `expected_immediate_action`
- `expected_do_not`
- `red_herrings`

## Consequences

- 3amoncall 側の fixture は将来的に probe-investigate の評価パイプラインへ接続しやすくなる
- `scenario.schema.json` 側に `validation_extensions` の optional 追加が必要になる
- `trigger` と `detail.trigger_signal` は意味が異なるため、用語を混同しない

## Related

- [validation-mvp-v0.1.md](/Users/murase/project/3amoncall/docs/validation-mvp-v0.1.md)
- [compose-and-scenario-draft-v0.1.md](/Users/murase/project/3amoncall/docs/compose-and-scenario-draft-v0.1.md)
