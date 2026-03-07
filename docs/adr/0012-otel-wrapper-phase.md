# ADR 0012: OTel Wrapper のフェーズ分割

- Status: Accepted
- Date: 2026-03-07

## Context

3amoncall のセットアップ体験として、Dynatrace 的な「1行インストールで全部動く」ラッパーパッケージ（`@3amoncall/otel`）が必要かどうかを検討した。

OSS ツールにおける採用摩擦の解消は生死を分ける。一方で、Phase 1 では Receiver + CLI による診断パイプラインの価値実証が最優先であり、ラッパーの作り込みはその前に行うべきではない。

## Decision

### Phase 1

`@3amoncall/otel` パッケージは作らない。代わりにセットアップガイド（ドキュメント）で代替する。

- `@vercel/otel` 等の既存 OTel SDK を使う設定例を提供
- 診断に必要な attribute の付与方法をガイドに記載

### Phase 2（OSS 公開）

`@3amoncall/otel` パッケージを必ず作る。

- OTel SDK の上に乗る opinionated wrapper
- 1行セットアップで HTTP / DB / fetch 自動計装、console.log → OTel Logs 変換、Vercel / CF Workers 環境の自動検出
- これがないと採用摩擦が高すぎて誰も使わない

## Rationale

- Phase 1 のコア価値は「OTel データを診断する」こと。ラッパーはその価値を届けるための手段であり、価値そのものではない
- CF Workers での自動計装はランタイム制約（native module 不可等）があり、複数の実アプリで検証してから作り込む方が品質リスクが低い
- OSS 公開時に採用摩擦がある状態では誰も使わないため、Phase 2 での実装は必須

## Consequences

- Phase 1 はセットアップに手間がかかる（ドキュメントで補う）
- Phase 2 でラッパーを作るまで「1行セットアップ」は実現しない
