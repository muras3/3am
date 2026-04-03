# ADR 0008: Problem Grouping and Packetization Without LLM

- Status: Accepted
- Date: 2026-03-07

## Context

`incident packet` を Receiver で生成する方針は決まっているが、その前段で何を LLM に任せ、何を deterministic に処理するかも固定する必要がある。

フルスケール run では raw observability inputs が数 MB 規模になりうる。  
この状態で problem grouping や packetization まで LLM に任せると、以下の問題が出る。

- context window の肥大化
- token cost の増大
- 同じ run に対する grouping の不安定化
- 評価再現性の低下

既存の observability AI も、複数アラートの problem 化や関連 signal の抽出は前段の correlation layer で行い、その後に推論へ渡す設計が一般的である。

## Decision

以下は **LLM を使わず**、Receiver の application logic として実装する。

- 複数 signal / alert の **problem grouping**
- incident window の決定
- service / route / deployment / dependency の scope narrowing
- changed metrics / representative traces / relevant logs / platform events の抽出
- `incident packet` 生成

LLM（v5）は、この前段で作られた incident packet を受け取って

- trigger
- root_cause
- causal_chain
- recovery_action

を推論する層として使う。

## Consequences

- problem grouping と packetization の再現性が上がる
- LLM token 使用量を抑えられる
- `何をまとめるか` と `どう解釈するか` を別々に改善できる
- Incident Console と診断ランタイムが同じ packet を共有できる
- 将来的に LLM を差し替えても前段の correlation logic はそのまま使える

## Related

- [0007-incident-packet-generated-in-receiver.md](/Users/murase/project/3am/docs/adr/0007-incident-packet-generated-in-receiver.md)
- [0005-raw-evaluation-inputs.md](/Users/murase/project/3am/docs/adr/0005-raw-evaluation-inputs.md)
- [product-concept-v0.2.md](/Users/murase/project/3am/docs/product-concept-v0.2.md)
