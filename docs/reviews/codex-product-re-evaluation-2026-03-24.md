# Codex Product Re-evaluation — 2026-03-24

- Target: `3amoncall`
- Reviewer: `Codex`
- Mode: code-and-document re-evaluation with latest repo and platform references
- Basis:
  - [codex-product-re-evaluation-2026-03-19.md](/Users/murase/project/3amoncall/docs/reviews/codex-product-re-evaluation-2026-03-19.md)
  - [production-audit-2026-03-23-v2.md](/Users/murase/project/3amoncall/validation/production-audit-2026-03-23-v2.md)
  - [railway-product-verification-2026-03-23.md](/Users/murase/project/3amoncall/validation/e2e-screenshots/railway-product-verification-2026-03-23.md)
  - [product-concept-v0.2.md](/Users/murase/project/3amoncall/docs/product-concept-v0.2.md)
  - [PR #145: Cloudflare Workers deploy (D1 + Static Assets)](https://github.com/muras3/3amoncall/pull/145)
  - [origin/develop @ 8eae756](https://github.com/muras3/3amoncall/tree/develop)
  - [Vercel Functions: `waitUntil`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package)
  - [Vercel database pool guidance](https://vercel.com/guides/connection-pooling-with-functions)

## 確認方法

- 現行コード確認:
  - `apps/console/src/components/lens/evidence`
  - `apps/receiver/src/transport`
  - `apps/receiver/src/runtime`
  - `apps/receiver/src/storage/drizzle`
  - `apps/receiver/src/telemetry/drizzle`
- リモート確認:
  - `origin/develop` の先頭は `8eae756`
  - 2026-03-24 に PR #143 `Ground grounded Q&A on evidence/query contract` が merge 済み
  - 2026-03-24 に PR #145 `Cloudflare Workers deploy (D1 + Static Assets)` が merge 済み
- 実行確認:
  - `pnpm -s typecheck` は成功
  - `pnpm -s test` は成功

この評価は 03-19 レポートの言い換えではなく、`2026-03-24` 時点の `develop` と直近 validation を踏まえて、プロダクトとしてどこまで閉じたかを再判定したものです。

## 総合評価

`Codex` の今回の総合評価は `A` です。

03-19 時点の `A-` から 1 段上げます。理由は、前回までの「良い incident board と良い evidence data はあるが、最後の導線がまだ弱い」という状態から、`develop` がその最後の導線をかなり回収したからです。具体的には、Runtime Map が `TelemetryStore` ベース + incident-scoped fallback で空表示に寄りにくくなり、Evidence Tabs は WAI-ARIA tabs 化され、遮蔽バグを対象にした E2E も入り、さらに 03-24 の PR #143 で grounded evidence query が UI と contract まで接続されました。また PR #145 により、Cloudflare Workers + D1 でも実地 deploy・ingest・incident 作成・Console SPA 配信まで確認され、以前の最大不確実性だった `Cloudflare で本当に成立するのか` は大きく後退しました。[runtime-map.ts](/Users/murase/project/3amoncall/apps/receiver/src/ambient/runtime-map.ts) [LensEvidenceTabs.tsx](/Users/murase/project/3amoncall/apps/console/src/components/lens/evidence/LensEvidenceTabs.tsx) [evidence-studio-interactions.spec.ts](/Users/murase/project/3amoncall/apps/console/e2e/specs/evidence-studio-interactions.spec.ts) [QAFrame.tsx](/Users/murase/project/3amoncall/apps/console/src/components/lens/evidence/QAFrame.tsx) [evidence-query.ts](/Users/murase/project/3amoncall/apps/receiver/src/domain/evidence-query.ts) [PR #145: Cloudflare Workers deploy (D1 + Static Assets)](https://github.com/muras3/3amoncall/pull/145)

一方で `A+` にしない理由もはっきりしています。残課題が「小さな polish」ではなく、serverless 本番運用に効くものだからです。chat / evidence-query の保護は cookie + rate limit まで入ったものの、その state は依然 in-memory です。Vercel 側では storage / telemetry で独立 pool を張っており、platform 推奨の接続運用にはまだ寄っていません。さらに Cloudflare 検証でも、遅延診断 (`DIAGNOSIS_MAX_WAIT_MS > 0`) は fire-and-forget のままで、診断実行保証の弱さが新しい主要論点として残りました。保持期間も product concept では `最大3日` と言いながら、実コードでは closed incident の削除 API が定義されているだけで、定期実行まで閉じていません。[session-cookie.ts](/Users/murase/project/3amoncall/apps/receiver/src/middleware/session-cookie.ts) [rate-limit.ts](/Users/murase/project/3amoncall/apps/receiver/src/middleware/rate-limit.ts) [postgres.ts](/Users/murase/project/3amoncall/apps/receiver/src/storage/drizzle/postgres.ts) [postgres.ts](/Users/murase/project/3amoncall/apps/receiver/src/telemetry/drizzle/postgres.ts) [product-concept-v0.2.md](/Users/murase/project/3amoncall/docs/product-concept-v0.2.md) [PR #145: Cloudflare Workers deploy (D1 + Static Assets)](https://github.com/muras3/3amoncall/pull/145)

## QCD評価

### Quality: A

今回もっとも評価を引き上げるのは、質の改善が UI 文言ではなく contract とテストまで落ちていることです。Evidence Q&A は単なる freeform chat ではなく、retrieval → grounded answer / no-answer → evidence refs → followups まで構造化されています。`diagnosis unavailable` や `pending` の場合は無理に答えず、根拠のない narrative を抑制する設計です。[curated-evidence.ts](/Users/murase/project/3amoncall/packages/core/src/schemas/curated-evidence.ts) [generate-evidence-query.ts](/Users/murase/project/3amoncall/packages/diagnosis/src/generate-evidence-query.ts) [evidence-query.ts](/Users/murase/project/3amoncall/apps/receiver/src/domain/evidence-query.ts)

さらに、前回弱かった accessibility / interaction quality も改善しています。Evidence tabs は `role="tab"` / `aria-selected` / keyboard navigation を持ち、L1→L2 zoom 後でも tab click できることを E2E で押さえています。03-23 validation で critical 扱いだった「Evidence タブ遮蔽バグ」は、現行コードでは放置されていないと判断できます。[LensEvidenceTabs.tsx](/Users/murase/project/3amoncall/apps/console/src/components/lens/evidence/LensEvidenceTabs.tsx) [evidence-studio-interactions.spec.ts](/Users/murase/project/3amoncall/apps/console/e2e/specs/evidence-studio-interactions.spec.ts) [production-audit-2026-03-23-v2.md](/Users/murase/project/3amoncall/validation/production-audit-2026-03-23-v2.md)

ただし quality の未解決点は still core です。chat endpoint の Anthropic client は diagnosis path と違って明示的な `timeout` / `maxRetries` を持たず、障害時のふるまいが非対称です。DB 読み戻しの JSONB も schema re-parse ではなく cast ベースで、evolution に対する fail-fast 性は弱いままです。[api.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/api.ts) [model-client.ts](/Users/murase/project/3amoncall/packages/diagnosis/src/model-client.ts) [postgres.ts](/Users/murase/project/3amoncall/apps/receiver/src/storage/drizzle/postgres.ts)

### Cost: B+

このリポジトリは相変わらずレビュー・ADR・validation 文書の比率が高いです。ただ、03-24 の時点ではそのコストはまだ正当化されています。理由は、今回の前進が「感覚的な改善」ではなく、直前 audit の指摘を具体的に潰した結果だからです。03-23 audit が示した production gap と 03-24 merge の grounded Q&A 実装は、文書駆動が実装回収に結びついている例です。[production-audit-2026-03-23-v2.md](/Users/murase/project/3amoncall/validation/production-audit-2026-03-23-v2.md)

ただし今後も同じ密度で文書だけが増えると費用対効果は落ちます。ここから先は、新しい review を増やすより、保持期間・接続運用・response limits のような runtime realism を閉じる方が ROI は高いです。

### Delivery: A

delivery は継続して強いです。`origin/develop` は 03-24 に PR #143 を merge して grounded evidence query を回収し、その同日に PR #145 で Cloudflare Workers + D1 deploy spike まで到達しています。Evidence Studio の grounded query と Cloudflare deploy verification はどちらもコア主張に直結しており、「質問できるが grounded ではない」「Cloudflare で動くか不明」という 2 つの大きい不確実性を同日に縮めています。[origin/develop @ 8eae756](https://github.com/muras3/3amoncall/tree/develop) [PR #145: Cloudflare Workers deploy (D1 + Static Assets)](https://github.com/muras3/3amoncall/pull/145)

加えて、`pnpm -s typecheck` と `pnpm -s test` が現時点で green で、receiver 側は 900 超の test が通っています。delivery が速いだけでなく、回帰耐性も維持できています。

## 観点別評価

### プロダクト定義との整合: A

`午前3時に叩き起こされたエンジニアが、5分以内に原因を特定し、正しい初動を取れるようにする` という product concept との整合は、以前より強くなりました。理由は、Immediate Action と Root Cause だけでなく、その根拠確認と follow-up 質問まで incident-scoped に閉じつつあるからです。[product-concept-v0.2.md](/Users/murase/project/3amoncall/docs/product-concept-v0.2.md)

03-23 の Railway verification でも、診断エンジン自体は `76秒` で初動提案に到達していました。03-24 の develop は、その「診断そのものは強い」を console 側の導線改善で支える方向に進んでいます。[railway-product-verification-2026-03-23.md](/Users/murase/project/3amoncall/validation/e2e-screenshots/railway-product-verification-2026-03-23.md)

### UX / オペレータ体験: A-

前回の `B+` から明確に上げます。Runtime Map 空表示は `TelemetryStore` 由来の 30 分 window と incident-scoped fallback で改善され、Evidence tabs は操作不能状態から脱しています。Q&A も固定文ではなく、evidence refs に飛べる grounded answer / no-answer モデルになりました。[runtime-map.ts](/Users/murase/project/3amoncall/apps/receiver/src/ambient/runtime-map.ts) [QAFrame.tsx](/Users/murase/project/3amoncall/apps/console/src/components/lens/evidence/QAFrame.tsx)

それでも満点をつけないのは、3am operator の first viewport 最適化がまだ完全ではないからです。03-23 audit で出ていた「incident board の重要情報はまだ縦に長い」という評価は、今回の commit 群では本質的にはまだ残ります。つまり、`触れれば理解できる` にはかなり近づいたが、`一瞬で把握できる` にはまだ少し届いていません。[production-audit-2026-03-23-v2.md](/Users/murase/project/3amoncall/validation/production-audit-2026-03-23-v2.md)

### アーキテクチャ: A

アーキテクチャは引き続き強いです。receiver が deterministic layer、diagnosis package が LLM layer、console が curated consumption layer という分割は保たれており、今回の grounded evidence query もその分割を崩さずに入っています。特に `no_answer` を contract に持ち込んだのは、AI を product 上で安全に扱うための正しい判断です。[curated-evidence.ts](/Users/murase/project/3amoncall/packages/core/src/schemas/curated-evidence.ts)

ただし runtime architecture の realism はまだ unfinished です。PR #145 によって Cloudflare でも「起動・保存・ingest・incident 作成」が成立することは示せましたが、同じ PR の既知制約が示す通り、遅延診断は Workers では fire-and-forget のままです。つまり platform compatibility は前進したが、診断トリガーの durable 性はまだ未解決です。[Vercel Functions: `waitUntil`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package) [diagnosis-debouncer.ts](/Users/murase/project/3amoncall/apps/receiver/src/runtime/diagnosis-debouncer.ts) [PR #145: Cloudflare Workers deploy (D1 + Static Assets)](https://github.com/muras3/3amoncall/pull/145)

### コード品質: A-

今回の `develop` で最も良いのは、改善が test-first に近い形で残っていることです。Evidence Studio まわりは unit test と E2E の両方が追加され、receiver 側の evidence query も domain test と API test を持ちます。これは UI 機能の追加としてはかなり良い進め方です。[LensEvidenceStudio.test.tsx](/Users/murase/project/3amoncall/apps/console/src/__tests__/LensEvidenceStudio.test.tsx) [evidence-query-api.test.ts](/Users/murase/project/3amoncall/apps/receiver/src/__tests__/transport/evidence-query-api.test.ts)

一方で、`盤石` と言うにはまだ早いです。storage と telemetry で独立に `postgres(..., { max: 10 })` を張る構成は、serverless DB connection 管理として雑味が残ります。Vercel は関数環境での pool attachment を案内している一方、現行コードにはその運用が見えません。また raw telemetry endpoints には page / cap がなく、incident が大きくなるほど重くなりやすいです。[postgres.ts](/Users/murase/project/3amoncall/apps/receiver/src/storage/drizzle/postgres.ts) [postgres.ts](/Users/murase/project/3amoncall/apps/receiver/src/telemetry/drizzle/postgres.ts) [api.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/api.ts) [Vercel database pool guidance](https://vercel.com/guides/connection-pooling-with-functions)

### AI / 診断品質: A

ここは 03-19 の `A-` から引き上げます。理由は、AI の評価対象が stage 1 diagnosis 単体ではなくなったからです。いまの 3amoncall は、

- stage 1 diagnosis
- stage 2 narrative
- grounded evidence query
- no-answer fallback

まで含めて、operator-facing AI 導線をかなり閉じています。[diagnosis-runner.ts](/Users/murase/project/3amoncall/apps/receiver/src/runtime/diagnosis-runner.ts) [generate-evidence-query.ts](/Users/murase/project/3amoncall/packages/diagnosis/src/generate-evidence-query.ts)

特に高く評価するのは、「答えない設計」を入れたことです。diagnosis 未完了や unavailable のときに無理に narrative を返さず、curated evidence に退避する判断は、障害対応プロダクトとして重要です。ここは派手ではないが product quality を上げる change です。

ただし AI 系の最後の穴は残ります。chat endpoint のモデル呼び出しだけ diagnosis path と resilience policy が揃っておらず、product 全体で AI 呼び出し品質が完全に均質ではありません。[api.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/api.ts) [model-client.ts](/Users/murase/project/3amoncall/packages/diagnosis/src/model-client.ts)

### 運用 / リリース成熟度: A-

ここは 1 段上げて `A-` にします。理由は、Vercel に加えて Cloudflare Workers + D1 の live deploy が確認され、クロスプラットフォームの deploy realism が一気に上がったからです。`vercel.json` による Vercel 側の成立だけでなく、Workers Static Assets 同居配信、D1 永続化、OTLP JSON ingest、incident 作成まで確認されたのは大きいです。[vercel.json](/Users/murase/project/3amoncall/vercel.json) [PR #145: Cloudflare Workers deploy (D1 + Static Assets)](https://github.com/muras3/3amoncall/pull/145)

特に厳しく見る点は 3 つです。

1. session cookie / rate limit は instance-local で、multi-instance では保証が割れること
2. delayed diagnosis の実行保証は依然弱く、Cloudflare では fire-and-forget 制約が明示されたこと
3. retention は concept 上 `最大3日` だが、実装は `deleteExpiredIncidents()` と `deleteSnapshots()` の API があるだけで、常時実行の wiring が見えないこと

[session-cookie.ts](/Users/murase/project/3amoncall/apps/receiver/src/middleware/session-cookie.ts) [rate-limit.ts](/Users/murase/project/3amoncall/apps/receiver/src/middleware/rate-limit.ts) [client.ts](/Users/murase/project/3amoncall/apps/console/src/api/client.ts) [product-concept-v0.2.md](/Users/murase/project/3amoncall/docs/product-concept-v0.2.md) [PR #145: Cloudflare Workers deploy (D1 + Static Assets)](https://github.com/muras3/3amoncall/pull/145)

## 今回 `Codex` が高く評価する点

- `origin/develop` が 2026-03-24 に grounded evidence query を merge し、AI Copilot の「質問できるが根拠が弱い」状態から前進したこと
- Runtime Map が live window empty 時でも incident-scoped fallback を返せるようになり、normal mode の空振りが減ったこと
- Evidence tabs が ARIA tabs + keyboard nav + E2E regression まで入っており、前回の critical UI bug をちゃんとプロダクト品質として扱っていること
- `no_answer` を contract 化し、unsupported なときに答えない AI にしていること
- Cloudflare Workers + D1 で live deploy・ingest・incident 作成・Console SPA 配信まで確認され、クロスプラットフォームの主張が机上設計ではなくなったこと
- `pnpm -s typecheck` / `pnpm -s test` が現時点で green であること

## 今回 `Codex` が厳しく見る点

- in-memory session / rate limit は serverless production の保証としてまだ弱いこと
- Postgres pool が storage と telemetry で分かれ、platform 推奨の接続運用まで閉じていないこと
- delayed diagnosis の実行保証が Cloudflare では fire-and-forget に留まること
- raw telemetry endpoints に response cap がなく、大きい incident で素直に重くなりうること
- chat endpoint だけ AI client の timeout / retry 方針が揃っていないこと
- `最大3日保持` という product promise と cleanup wiring がまだ同期していないこと

## Codex結論

`Codex` の今回の結論として、3amoncall はもう `狭い条件なら価値が出る` 段階を越えつつあります。現時点では `serverless 小規模チーム向けの incident-first diagnosis product` として、実装・検証・UI・AI の主要導線がかなり一体化してきました。その意味で、03-19 の `A-` から 03-24 の `A` への引き上げは妥当です。

次に越えるべき壁は新機能ではありません。Cloudflare 実地検証によって、「動くかどうか」より「どこまで安定に運用できるか」が中心論点になりました。優先順位は次の 3 点です。

1. diagnosis trigger の実行保証を、少なくとも `未診断の可視化 + 再実行` まで含めて閉じる
2. DB connection と telemetry response limits を production traffic 前提で整える
3. `3日保持` を cleanup job まで含めて product promise と実装で一致させる

ここを閉じられれば、3amoncall は `よくできた技術検証` ではなく、`本当に持続運用できる 3am 障害初動プロダクト` に入ります。
