# ADR 0015: Diagnosis Runtime Is GitHub Actions First, With CLI Parity

- Status: Accepted
- Date: 2026-03-08

## Context

Phase 1 では、Receiver が生成した `incident packet` をどこで消費して診断するかを決める必要がある。

候補には GitHub Actions、ローカル CLI、Vercel Functions、Cloudflare Workers などがある。  
一方で、要件は 2 つある。

- ユーザー向けの推奨構成として、運用しやすく秘密情報の置き場所が自然であること
- 開発・検証・replay のために、同じ packet をローカルでも確実に再実行できること

## Decision

Phase 1 の診断ランタイムは **GitHub Actions を推奨構成**とする。  
同時に、**CLI でも同じ incident packet を消費して同等の診断を実行できる**ことを必須要件とする。

責務分離は以下とする。

- **Receiver**
  - OTel / platform logs ingest
  - 異常検知
  - `incident packet` 生成
  - webhook 発火
- **GitHub Actions**
  - webhook または packet 入力を受ける
  - 診断を実行する
  - 結果を保存・通知する
- **CLI**
  - packet を直接読み込んで診断を実行する
  - replay / 開発 / デバッグ / evaluation に使う
  - 本番導線の主経路にはしない

GitHub Actions と CLI は、同一の packet schema と同一の診断入力契約を共有する。

## Rationale

- GitHub Secrets は LLM API key の置き場所として受け入れられやすい
- Receiver 側に LLM API key を置かずに済む
- CLI parity があれば、開発時に Actions 依存で詰まらない
- packet 消費側を複数持てると、将来の hosted runtime 追加にもつなげやすい

## Consequences

- 本番の推奨導線は GitHub に依存する
- CLI は開発補助ではなく、packet 契約を検証する正式な consumer になる
- Runtime 実装は変えられても、packet schema の互換性維持が重要になる

## Related

- [0007-incident-packet-generated-in-receiver.md](/Users/murase/project/3amoncall/docs/adr/0007-incident-packet-generated-in-receiver.md)
- [0008-problem-grouping-and-packetization-without-llm.md](/Users/murase/project/3amoncall/docs/adr/0008-problem-grouping-and-packetization-without-llm.md)
- [product-concept-v0.2.md](/Users/murase/project/3amoncall/docs/product-concept-v0.2.md)
