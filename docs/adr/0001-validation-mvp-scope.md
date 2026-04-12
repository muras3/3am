# ADR 0001: Validation MVP Scope

- Status: Accepted
- Date: 2026-03-06

## Context

3am のユーザー向け MVP は `Receiver -> トリガー -> 診断 -> 通知` を前提にしている。  
一方で、現時点では実インシデント由来の OTel データがなく、LLM 診断の品質をどう改善するかが別の問題として存在する。

この 2 つを同時に解こうとすると、診断品質の問題と導入体験の問題が混ざり、改善ループが遅くなる。

## Decision

検証MVPとユーザー向けMVPを分離する。

- ユーザー向けMVP
  - `Receiver -> トリガー -> 診断 -> 通知`
- 検証MVP
  - `再現可能な障害シナリオ -> 実測OTel収集 -> 診断 -> 採点`

検証MVPの目的は、実測 OTel を使った診断改善ループを高速に回すこととする。

## Consequences

- Receiver はプロダクトMVPに必要だが、検証MVPの必須要件ではない
- 検証では dump 手動投入ではなく、障害再現ハーネスから fixture を生成する
- 評価は `root cause 正答率` 単独ではなく、初動有効性と危険な誤提案の有無も重視する

## Related

- [validation-mvp-v0.1.md](/Users/murase/project/3am/docs/validation-mvp-v0.1.md)
- [product-concept-v0.1.md](/Users/murase/project/3am/docs/product-concept-v0.1.md)
