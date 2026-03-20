# ADR 0034: Receiver 内診断と credential separation 廃止

## Status

Accepted

## Context

product-concept-v0.2 では、Receiver と診断ランタイム (GitHub Actions) を分離し、LLM API key を Receiver に持たせない credential separation を設計した (ADR 0015)。

しかし、Deploy Button による 1-click セルフホスト体験を実現するにあたり、この分離がユーザーの導入障壁になることが判明した。

### 元の設計の問題点

1. **UX の摩擦**: Deploy Button 完了後に GitHub Secrets の設定、workflow の理解、thin event の webhook 設定が必要
2. **credential separation の実効性**: セルフホスト OSS では同一ユーザーが Receiver と GitHub リポの両方を所有する。GitHub 侵害 → Vercel ピボット、Vercel 侵害 → GitHub ピボットが可能であり、分離は実質的な防御にならない
3. **DiagnosisDebouncer の serverless 非互換**: in-memory setTimeout は Vercel serverless で動作しない。外部トリガー (GitHub Actions) への依存がさらに複雑性を増す

### セキュリティ分析

| 脅威 | 分離あり | 分離なし | 実質差 |
|------|---------|---------|--------|
| Receiver RCE (OTel payload injection) | DB のみ漏洩 | DB + LLM key 漏洩 | 理論上あり、実質極小 (protobuf パース + Hono の RCE 確率は極めて低い) |
| Credential leak (.env commit) | 同等 | 同等 | なし |
| Supply chain (deps 侵害) | 全 env var 露出 | 全 env var 露出 | なし |
| Platform 侵害 (GitHub/Vercel) | 相互ピボット可能 | 単一点 | 実質なし |

追加されるリスクは「Receiver RCE 時の LLM key 漏洩 (課金被害)」のみ。緩和策として Anthropic spending limit の設定を README で推奨する。

## Decision

1. **診断を Receiver 内で直接実行する** — `@3amoncall/diagnosis` の `diagnose()` を Receiver から直接呼び出す
2. **`ANTHROPIC_API_KEY` を Receiver の環境変数に追加する**
3. **GitHub Actions workflow は診断ランタイムとしては廃止する** — CLI (`3amoncall-cli --packet`) はローカル再現・評価用として維持
4. **thin event (ThinEventSchema) は外部通知用としては廃止する** — Receiver 内で診断が完結するため不要
5. **Vercel Firewall の rate limiting + WAF を推奨セキュリティ設定としてドキュメント化する**

## Consequences

### Positive

- Deploy Button が 1-click で完結する (ANTHROPIC_API_KEY の入力のみ)
- GitHub Actions のセットアップが不要になり、ユーザーの導入ステップが大幅に削減される
- アーキテクチャが単純化される (Receiver が唯一のサーバーコンポーネント)
- Vercel / Cloudflare の両プラットフォームで同一の `createApp()` がそのまま動く

### Negative

- Receiver 侵害時の blast radius が拡大する (LLM key が同居)
- product-concept-v0.2 の credential separation セクションの更新が必要
- Receiver の `maxDuration` が診断の LLM 応答時間をカバーする必要がある (現在 60s、十分)

### Neutral

- CLI (`3amoncall-cli`) は変更なし。ローカル再現・評価・CI 用途として維持
- `@3amoncall/diagnosis` パッケージは変更なし。呼び出し元が変わるだけ
- `@3amoncall/core` のスキーマは変更なし

## Addendum: waitUntil-based Diagnosis Debouncer

**Date**: 2026-03-19

### Problem

元の DiagnosisDebouncer は in-memory Map + `setTimeout` に依存していた。Vercel serverless では HTTP response 後にタイマーが消失するため、`vercel-entry.ts` で `DIAGNOSIS_GENERATION_THRESHOLD=0` / `DIAGNOSIS_MAX_WAIT_MS=0` を強制設定してデバウンサーを完全無効化するハックが必要だった。

### Solution

DiagnosisDebouncer class を削除し、2つの関数型 API に置き換えた:

1. **`scheduleDelayedDiagnosis()`** — `waitUntil()` を使用して、HTTP response 後もバックグラウンドで sleep + diagnosis を実行する。Vercel では `@vercel/functions` の `waitUntil()` が Function execution lifetime を延長する。ローカル Node.js では fire-and-forget fallback。
2. **`checkGenerationThreshold()`** — rebuildSnapshots 後に generation を確認し、閾値到達時は即座に診断を実行。

### Idempotency

二重発火防止は `runIfNeeded()` で実装: `storage.getIncident()` → `diagnosisResult` 存在チェック → 存在すればスキップ。`DiagnosisRunner.run()` 自体も ANTHROPIC_API_KEY チェックと incident 存在チェックを持つ。

### Platform Compatibility

| Platform | waitUntil source | Behavior |
|----------|-----------------|----------|
| Vercel | `@vercel/functions` (optionalDependency) | Function execution lifetime 延長 |
| Cloudflare Workers | Future: `ctx.waitUntil()` | 未実装 (Cloudflare 対応時に追加) |
| Local Node.js | fire-and-forget fallback | プロセスが生きている限り動作 |
