# Develop Phase B ADR and Security Review

- Date: 2026-03-08
- Target branch state: `develop`
- Reviewed commit basis: `ec5697fb86ba20eab9b709e1b1f25e06d0be7ac7` (`Merge pull request #40 from muras3/feat/phase-b-receiver-core`)
- Review scope:
  - ADR compliance
  - security / secure-by-default review

## Executive Summary

`develop@ec5697f` は **Phase B の骨格としては前進しているが、ADR 準拠の意味ではまだ未完成** である。  
Receiver の domain / transport / storage 分離は正しい方向だが、認証、ingest 方針、dependency extraction、packet access path に重要な未達が残っている。

最優先で直すべきなのは以下。

1. Receiver routes に Bearer Token 認証を追加する
2. anomaly detection を ADR 0023 の required signal に近づける
3. dependency identifier を packet に反映する
4. packet fetch API の 1000 件走査をやめる

## Findings

### F-101

- Severity: High
- Category: ADR compliance / security
- Location:
  - [apps/receiver/src/index.ts](/Users/murase/project/3amoncall/apps/receiver/src/index.ts#L10)
- Evidence:
  - `// TODO (Phase E): add bearer-token auth middleware before mounting routers.`
  - 実際の `createApp()` は `/v1/*` と `/api/*` を無認証で公開している
- Impact:
  - ADR 0011 (`HTTPS + Bearer Token`) に未準拠
  - ingest / packet / diagnosis result API を外部から無制限に叩ける
- Fix:
  - Bearer Token middleware を ingest と API の両方に追加する
  - 少なくとも Receiver が public network に露出する前に必須

### F-102

- Severity: High
- Category: ADR compliance
- Location:
  - [apps/receiver/src/transport/ingest.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/ingest.ts#L16)
  - [apps/receiver/src/transport/ingest.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/ingest.ts#L62)
- Evidence:
  - `/v1/traces` は `c.req.json()` 前提
  - `/v1/metrics`, `/v1/logs`, `/v1/platform-events` は body を捨てて `status: ok` を返すだけ
- Impact:
  - ADR 0022 の `OTLP/HTTP protobuf first-class` に未達
  - metrics / logs / platform ingest が contract-preserving な実装になっていない
- Fix:
  - 少なくとも transport contract と validation を入れる
  - protobuf-first 実装への移行前でも stub ではなく shape-aware handler にする

### F-103

- Severity: High
- Category: ADR compliance / diagnosis quality
- Location:
  - [apps/receiver/src/domain/anomaly-detector.ts](/Users/murase/project/3amoncall/apps/receiver/src/domain/anomaly-detector.ts#L11)
- Evidence:
  - `isAnomalous()` は `httpStatusCode >= 500` と `spanStatusCode === 2` しか見ていない
- Impact:
  - ADR 0023 required signals のうち `429`, duration, exception signal を取りこぼす
  - incident formation と diagnosis quality が弱くなる
- Fix:
  - `429`
  - duration threshold
  - exception event presence / count
  を anomaly 判定に加える

### F-104

- Severity: High
- Category: ADR compliance
- Location:
  - [apps/receiver/src/domain/anomaly-detector.ts](/Users/murase/project/3amoncall/apps/receiver/src/domain/anomaly-detector.ts#L88)
  - [apps/receiver/src/domain/packetizer.ts](/Users/murase/project/3amoncall/apps/receiver/src/domain/packetizer.ts#L33)
- Evidence:
  - `ExtractedSpan` に dependency identifier がない
  - `affectedDependencies: []` が固定
- Impact:
  - ADR 0023 required の dependency identifier を満たさない
  - root cause hypothesis の品質が落ちる
- Fix:
  - `peer.service` などを抽出して `ExtractedSpan` に追加
  - packetizer で dependency を集約する

### F-105

- Severity: High
- Category: scalability / correctness
- Location:
  - [apps/receiver/src/transport/api.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/api.ts#L21)
- Evidence:
  - `listIncidents({ limit: 1000 })` を全走査して `packetId` を探している
- Impact:
  - 1000 件を超えると valid packet が見つからない
  - Receiver API として不安定
- Fix:
  - `packet_id` index 相当の storage path を追加する
  - `getPacket(packetId)` のような API に寄せる

### F-106

- Severity: Medium
- Category: ADR compliance
- Location:
  - [apps/receiver/src/transport/ingest.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/ingest.ts#L48)
- Evidence:
  - `saveThinEvent()` まではしているが dispatch がない
- Impact:
  - ADR 0021 の `Receiver pushes thin event to GitHub Actions` は未達
- Fix:
  - Phase C で GitHub Actions dispatch を実装する
  - 少なくとも TODO と boundary を明確にしておく

### F-107

- Severity: Medium
- Category: contract quality
- Location:
  - [apps/receiver/src/domain/packetizer.ts](/Users/murase/project/3amoncall/apps/receiver/src/domain/packetizer.ts#L40)
- Evidence:
  - `representativeTraces: spans.slice(0, 10) as unknown[]`
  - `traceRefs` は traceId だけ
- Impact:
  - ADR 0018 の evidence / retrieval が弱く、Console deep dive 契約が薄い
- Fix:
  - representative trace の shape を絞る
  - retrieval refs に最低限の metadata を持たせる

### F-108

- Severity: Medium
- Category: secure input handling
- Location:
  - [apps/receiver/src/transport/api.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/api.ts#L8)
- Evidence:
  - `limit` は parse されるが、境界値制約がない
  - invalid query に対する validation が弱い
- Impact:
  - 極端な limit / malformed input を受け入れうる
- Fix:
  - query params に最小 / 最大を設ける
  - path/body と同様に入力境界を tighten する

## Security Notes

- 現時点で最重要の security issue は **無認証 API** である
- 次点は **入力境界の緩さ**
- まだ early Phase なので深刻な injection は見えないが、このまま platform に出すのは不可

## Overall Assessment

- Architecture direction: good
- ADR compliance: partial
- Security posture: not ready for exposure
- Phase status: Phase B skeleton, not Phase B complete

## Recommended Next Step

1. auth middleware
2. anomaly / dependency extraction
3. packet fetch path fix
4. tests update
5. Phase C に進む前に再レビュー
