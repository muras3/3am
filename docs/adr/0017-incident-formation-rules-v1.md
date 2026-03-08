# ADR 0017: Incident Formation Rules v1

- Status: Accepted
- Date: 2026-03-08

## Context

ADR 0007 と ADR 0008 により、Receiver が LLM を使わずに `incident packet` を生成する方針は決まっている。  
また ADR 0016 で、Phase 1 では更新前提の `incident packet v1alpha` を使うことも決まった。

しかし、packet を作る前段として「どの signals を 1 つの incident とみなすか」が未定のままだと、Receiver、Console、diagnosis runtime の主語が揃わない。

一方で、Phase 1 の目的は高度な相関エンジンを作ることではない。  
必要なのは、運用上意味のある `incident` 単位を deterministic かつ説明可能に作ることである。

## Decision

Phase 1 では、`incident formation` を Receiver の deterministic logic として実装する。

この logic は、alert をそのまま保存するだけの薄い grouping ではなく、**運用上意味のある incident 単位を作る**ことを目的とする。  
ただし、Dynatrace のような高度な自動相関までは目指さない。

### Formation の基本キー

新しい signal / alert を既存 incident に束ねるかどうかは、以下を主に使って判定する。

- `environment`
- `time window`
- `primary service`
- `dependency`

### 補助コンテキスト

以下は強い補助情報として incident に保持する。

- `deployment id` または `release version`
- `config change`
- `route`
- `platform event`

これらは v1 では主キーではないが、split / merge の補助判断には使ってよい。

### 初期ルール

- `environment` が異なるものは別 incident
- 最初の signal から **5 分以内**に発生した signal を incident 候補として比較する（暫定値。実データで調整する）
- `primary service` が同じ場合は同一 incident 候補とする
- `dependency` が同じで、かつ影響 service が連続している場合は同一 incident 候補とする
- `deployment/config change` が直前に存在する場合は、その incident の主要文脈として保持する
- merge に自信がない場合は split を優先する
- 最後の signal から **48 時間**新たな signal が来なければ incident をクローズする

### 非目標

Phase 1 では、以下は行わない。

- LLM による incident 単位の生成
- 複雑な service graph 推論による自動相関
- 完全な root cause 推定を formation layer で行うこと

`incident formation` は incident の箱を作る層であり、最終的な trigger / root cause / causal chain の解釈は LLM が担う。

## Rationale

- alert 単位のままだと、同一障害の診断が乱立しやすい
- 一方で、高度な相関エンジンを先に作ると Phase 1 の実装が重くなる
- `environment + time window + primary service/dependency` なら説明可能で実装しやすい
- deployment や config change を incident 文脈に含めることで、単なる alert grouping より実用的になる

## Consequences

- Incident Console は alert list ではなく incident list を主語にできる
- 診断ランタイムは incident 単位で packet を受け取れる
- 同一障害が分裂する可能性は残るが、過剰 merge より安全である
- formation ルールは実データを見ながら Phase 1 中に更新されうる

## Related

- [0007-incident-packet-generated-in-receiver.md](/Users/murase/project/3amoncall/docs/adr/0007-incident-packet-generated-in-receiver.md)
- [0008-problem-grouping-and-packetization-without-llm.md](/Users/murase/project/3amoncall/docs/adr/0008-problem-grouping-and-packetization-without-llm.md)
- [0016-incident-packet-v1alpha.md](/Users/murase/project/3amoncall/docs/adr/0016-incident-packet-v1alpha.md)
