# Develop Phase B Follow-up Review

- Date: 2026-03-08
- Target branch state: `develop`
- Reviewed commit basis: `ec5697fb86ba20eab9b709e1b1f25e06d0be7ac7`
- Review scope:
  - follow-up ADR compliance review
  - follow-up security review

## Executive Summary

PR #41 で前回の重要指摘の多くは改善された。特に以下は前進している。

- dependency identifier の抽出
- packet fetch の O(1) 化
- anomaly detection の強化
- auth tests と integration tests の追加

ただし、**まだ Phase B complete と呼ぶには早い**。  
未解決の主な論点は、secure-by-default の不足と ingest/contract の未完成さである。

## Findings

### F-201

- Severity: High
- Category: Security / secure-by-default
- Location:
  - [apps/receiver/src/index.ts](/Users/murase/project/3amoncall/apps/receiver/src/index.ts#L10)
- Evidence:
  - `RECEIVER_AUTH_TOKEN` が未設定だと `auth disabled (dev mode only)` で全ルートが無認証になる
- Impact:
  - secure-by-default ではない
  - 設定漏れのまま deploy すると ADR 0011 の protection が完全に外れる
- Fix:
  - 少なくとも production mode では startup fail にする
  - 明示的な `ALLOW_INSECURE_DEV_MODE=true` のような opt-in がない限り auth 無効化を許さない

### F-202

- Severity: High
- Category: ADR compliance
- Location:
  - [apps/receiver/src/transport/ingest.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/ingest.ts#L69)
- Evidence:
  - `application/x-protobuf` は一律 `501`
  - `/v1/traces` も JSON 前提
- Impact:
  - ADR 0022 の `OTLP/HTTP protobuf first-class` に未達
  - ingest 実装としてはまだ Phase B skeleton
- Fix:
  - protobuf 対応を実装するか、少なくとも `Phase B complete` 判定から外す

### F-203

- Severity: Medium
- Category: Security / resource exhaustion
- Location:
  - [apps/receiver/src/transport/ingest.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/ingest.ts#L16)
  - [apps/receiver/src/transport/ingest.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/ingest.ts#L74)
- Evidence:
  - request body のサイズ上限がないまま `c.req.json()` を読んでいる
- Impact:
  - 大きな JSON body による memory / CPU pressure を防げない
  - Web ingest endpoint としては unsafe default
- Fix:
  - body size limit を導入する
  - oversized payload を明示的に reject する

### F-204

- Severity: Medium
- Category: ADR compliance / contract quality
- Location:
  - [apps/receiver/src/domain/packetizer.ts](/Users/murase/project/3amoncall/apps/receiver/src/domain/packetizer.ts#L55)
  - [packages/core/src/schemas/incident-packet.ts](/Users/murase/project/3amoncall/packages/core/src/schemas/incident-packet.ts#L23)
- Evidence:
  - `representativeTraces` は typed shape になったが、`changedMetrics`, `relevantLogs`, `platformEvents`, refs は依然として loose
- Impact:
  - packet canonical model がまだ緩い
  - UI / worker / storage 間の drift を防ぎにくい
- Fix:
  - remaining evidence / retrieval fields に最低限の schema を入れる

### F-205

- Severity: Medium
- Category: Delivery confidence
- Location:
  - repo state
- Evidence:
  - 手元では install 済み依存がなく、テスト green を再現できていない
- Impact:
  - PR 記載の `70 tests pass` を reviewer がその場で確認できない
- Fix:
  - CI result link または workflow artifact を review record に残す
  - `pnpm install && pnpm test` の bootstrap を scripts に寄せる

## Overall Assessment

- Better than previous review: yes
- Safe to call fully done: no
- Phase B status: substantially improved, but still incomplete against ADR 0011 / 0022 / secure-by-default expectations

## Recommended Next Step

1. Make auth fail closed outside explicit dev mode
2. Add body size limits
3. Clarify protobuf milestone vs Phase B completion
4. Tighten remaining packet evidence / retrieval contracts

## Model Guidance

この先の Phase C 以降で Opus 4.6 を使う価値が高いのは、以下のような **難所の設計判断と厳格レビュー** である。

- packet / diagnosis / worker / UI の責務境界が揺れるとき
- `Phase X complete` と言ってよいかの重い完了判定レビュー
- security / ADR compliance / diagnosis quality を横断で見たいとき

逆に、通常の TypeScript 実装・schema 実装・テスト追加は Sonnet 4.6 で十分である。
