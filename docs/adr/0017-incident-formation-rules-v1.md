# ADR 0017: Incident Formation Rules v1

- Status: Accepted
- Date: 2026-03-08
- Updated: 2026-03-13 (dependency キーの具体化、split-first ルール、cross-service merge 上限、peerService normalization を追記)
- Amended by: [ADR 0033](0033-cross-service-incident-formation-via-trace-propagation.md) (trace-based cross-service merge を追加)

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
- `dependency` — OTel の `peer.service` 属性を使用する（後述の normalization ルールを適用）

### 補助コンテキスト

以下は強い補助情報として incident に保持する。

- `deployment id` または `release version`
- `config change`
- `route`
- `platform event`

これらは v1 では主キーではないが、split / merge の補助判断には使ってよい。

### peerService の正規化ルール

`peer.service` を `dependency` キーとして使用する前に、以下の正規化を行う。以下に該当する場合は `dependency = undefined` として扱い、fallback ルールへ移行する。

- 値が空文字または未定義
- loopback アドレス: `localhost`, `127.0.0.1`, `::1`
- 生 IP アドレス（IaaS 内部エンドポイントは `peer.service` として適切ではないため）

これらは `IGNORED_DEPENDENCY_NAMES` denylist として実装する（初期値は loopback + 生 IP のみ。実運用データに応じて拡張する）。

### 初期ルール

- `environment` が異なるものは別 incident
- 最初の signal から **5 分以内**に発生した signal を incident 候補として比較する（暫定値。実データで調整する）
- `primary service` が同じ場合は同一 incident 候補とする
- `dependency` が同じで、かつ影響 service が連続している場合は同一 incident 候補とする
- `deployment/config change` が直前に存在する場合は、その incident の主要文脈として保持する
- merge に自信がない場合は split を優先する
- 最後の signal から **48 時間**新たな signal が来なければ incident をクローズする

### dependency に基づく split ルール

- **split-first**: 同一サービスでも `dependency` が異なる場合は、原則として別 incident に split する
  例: `serviceA → Stripe` と `serviceA → Redis` は同一 primaryService であっても別 incident
- バッチ（同一処理単位内）に distinct な dependency が複数存在する場合は `dependency = undefined` とし、fallback ルールを適用する。ここでの distinct 判定は **normalization 後の値** で行う（例: `""` と `localhost` はどちらも `undefined` に落ちるため同一扱い → fallback）
- `dependency` がない場合のフォールバック: `environment + primaryService + 5min window` の従来ルールを使用する

### cross-service dependency merge の上限

複数の distinct な primaryService が同一 `dependency` を参照しているとき、それらを 1 つの incident に束ねる場合は以下の制約を設ける。

```
MAX_CROSS_SERVICE_MERGE = 3
```

この上限は **既存 incident の `scope.affectedServices` の件数**を基準とする（incident 全体の distinct service 数ではなく、現時点で蓄積済みの affectedServices の長さで判定する）。新たな signal の primaryService が既存 incident の affectedServices に未登録であり、かつ `affectedServices.length >= MAX_CROSS_SERVICE_MERGE` の場合は、既存 incident にマージせず新規 incident として扱う。

**根拠**: 検証シナリオ `third_party_api_rate_limit_cascade` では Stripe を呼ぶサービスが 2 件存在し、これを 1 incident に収めることが正しい。`MAX_CROSS_SERVICE_MERGE = 3` はこのケースを許容しつつ、第 4 サービス以降の pull-in を防ぐ保守値である。実運用データで調整余地がある。

この制約は Stripe / DB / Redis のような単一巨大 dependency が多数のサービスを巻き込む mega-incident の発生を防ぐ guard としても機能する。

### Trace-based cross-service merge (ADR 0033)

> **Amendment (2026-03-17):** [ADR 0033](0033-cross-service-incident-formation-via-trace-propagation.md) により、上記ルールに加えて **同一 traceId に属する anomalous span が複数 service にまたがる場合の cross-service merge** が追加された。これは primaryService match / dependency match のいずれにも該当しない場合のフォールバックとして機能する。`MAX_CROSS_SERVICE_MERGE` ガードは維持される。

### 非目標

Phase 1 では、以下は行わない。

- LLM による incident 単位の生成
- ~~複雑な service graph 推論による自動相関~~ → ADR 0033 で trace propagation ベースの cross-service merge を導入。ただし永続的な dependency graph の構築は引き続き非目標
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
- **split-first** により、異なる dependency を持つ信号は独立した incident として扱われるため、診断対象が明確になる一方、同一障害が複数 incident に分裂しうる
- `IGNORED_DEPENDENCY_NAMES` denylist を適切に管理しないと、loopback/IP がキーとして混入するリスクがある（初期実装で対処済みだが、新しい IaaS エンドポイントパターンは継続的に確認が必要）
- `MAX_CROSS_SERVICE_MERGE = 3` は保守値であり、実運用データによっては 2〜5 の範囲で再調整が想定される

## Related

- [0007-incident-packet-generated-in-receiver.md](/Users/murase/project/3amoncall/docs/adr/0007-incident-packet-generated-in-receiver.md)
- [0008-problem-grouping-and-packetization-without-llm.md](/Users/murase/project/3amoncall/docs/adr/0008-problem-grouping-and-packetization-without-llm.md)
- [0016-incident-packet-v1alpha.md](/Users/murase/project/3amoncall/docs/adr/0016-incident-packet-v1alpha.md)
- [0033-cross-service-incident-formation-via-trace-propagation.md](0033-cross-service-incident-formation-via-trace-propagation.md) — trace-based cross-service merge 拡張
