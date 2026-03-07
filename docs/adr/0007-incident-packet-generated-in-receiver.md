# ADR 0007: Generate Incident Packets in the Receiver

- Status: Accepted
- Date: 2026-03-07

## Context

フルスケール run では raw observability inputs が数 MB 規模になり、そのまま LLM に流し込むと context window と推論品質の両方で不利になる。

既存の observability AI は、生ログ・生 trace を一括投入するのではなく、先に incident scope を絞り、関連 signal を束ねた上で推論させている。  
3amoncall でも、LLM に渡す前段として `incident packet` を生成する層が必要である。

`incident packet` は LLM を必要としない。役割は以下である。

- incident window の決定
- 関連 route / service / dependency / deployment の絞り込み
- changed metrics / representative traces / relevant logs / platform events の抽出
- Incident Console と診断ランタイムが共通で使える evidence bundle の生成

## Decision

`incident packet` は **Receiver（セルフホスト）で生成する**。

責務分離は以下とする。

- **Receiver**
  - OTel / platform logs ingest
  - 短期バッファ
  - 異常検知
  - incident packet 生成
  - Incident Console 用の短期保存
- **CLI**
  - validation harness / replay / packet schema の検証用
  - 本番導線の中核には置かない
- **診断ランタイム（GitHub Actions など）**
  - incident packet を受け取り、v5 で診断する
  - Slack 通知を返す

## Consequences

- LLM は raw dump 全体ではなく、incident-scoped な packet を読む
- packet 生成と診断推論を分離できるため、評価も改善しやすい
- Receiver は ingest endpoint ではなく、軽量な correlation / packaging 層になる
- GitHub Actions は packet 消費側として使いやすいが、packet 生成の本体には向かない
- CLI は依然として重要だが、役割は開発用・検証用である

## Related

- [0001-validation-mvp-scope.md](/Users/murase/project/3amoncall/docs/adr/0001-validation-mvp-scope.md)
- [0005-raw-evaluation-inputs.md](/Users/murase/project/3amoncall/docs/adr/0005-raw-evaluation-inputs.md)
- [product-concept-v0.2.md](/Users/murase/project/3amoncall/docs/product-concept-v0.2.md)
