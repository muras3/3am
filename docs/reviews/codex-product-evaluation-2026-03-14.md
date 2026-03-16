# Codexレビュー報告書

- 対象: `3amoncall`
- レビュアー: `Codex`
- 日付: `2026-03-14`
- 参照:
  - [product-definition-v0-2026-03-12.md](/Users/murase/project/3amoncall/docs/design/product-definition-v0-2026-03-12.md)
  - [product-definition-impact-report-2026-03-12.md](/Users/murase/project/3amoncall/docs/design/product-definition-impact-report-2026-03-12.md)
  - [develop-overall-review-2026-03-10.md](/Users/murase/project/3amoncall/docs/reviews/develop-overall-review-2026-03-10.md)
  - [uiux-review-codex-2026-03-12.md](/Users/murase/project/3amoncall/docs/reviews/uiux-review-codex-2026-03-12.md)

## 総合評価

`Codex` の総合評価は `B+` です。3amoncall は、個人開発者や少人数チーム向けの `act-first reliability console` というプロダクト定義に対して、かなり真っ当に前進しています。特に、設計文書、ADR、レビュー、実装が同じ方向を向いている点は強いです。単なる観測UIやAI説明ダッシュボードではなく、「障害時の初動を支えるプロダクト」を本気で作ろうとしていることが、資料とコードの両方から確認できます。

一方で、`Codex` から見る現時点の主要課題は、アーキテクチャではなく operator 体験です。プロダクト定義は `最初の30秒で何が壊れ、何を止めるべきか分かること` を要求していますが、そこはまだ完全には満たせていません。また、実測では `lint` と `test` は通る一方、`typecheck` が失敗しており、コード品質評価には留保が必要です。

## QCD評価

### Quality: B+

構造は良いです。`console`, `receiver`, `core`, `diagnosis`, `cli` の責務分離は健全で、ambient read model や incident workspace も無理なく乗っています。[AppShell.tsx](/Users/murase/project/3amoncall/apps/console/src/components/shell/AppShell.tsx#L19) [api.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/api.ts#L77)

ただし、`pnpm -s typecheck` は失敗しました。主因は [packet-rebuild.test.ts](/Users/murase/project/3amoncall/apps/receiver/src/__tests__/packet-rebuild.test.ts#L399) の `.ts` 直接 import と、[tsconfig.json](/Users/murase/project/3amoncall/apps/receiver/tsconfig.json#L1) の設定不整合です。`Codex` としては、これは小さくない品質シグナルです。

### Cost: B

ドキュメントコストは高めです。ただ、このプロジェクトではそれが無駄になっておらず、設計ドリフト防止とレビュー品質向上に効いています。[develop-overall-review-2026-03-10.md](/Users/murase/project/3amoncall/docs/reviews/develop-overall-review-2026-03-10.md#L102)

`Codex` の見立てでは、現状は「重いが正当化できるコスト」です。

### Delivery: A-

進捗速度はかなり強いです。normal/incident の二面性、proof-first header、ambient API、E2E、CI まで短期間で積めています。[NormalSurface.tsx](/Users/murase/project/3amoncall/apps/console/src/components/shell/NormalSurface.tsx#L10) [ci.yml](/Users/murase/project/3amoncall/.github/workflows/ci.yml)

ただし、release/bundle 周りは未完成で、[package.json](/Users/murase/project/3amoncall/apps/receiver/package.json#L6) にも未完了項目があります。

## 観点別評価

### プロダクト定義との整合: A-

`Codex` はこの点を高く評価します。`MTTRを最小化する`, `安全な初動を1つだけ強く提示する`, `evidenceで裏取りできる`, `復旧確認を支援する` という定義は明確で、実装もそこに寄せています。[product-definition-v0-2026-03-12.md](/Users/murase/project/3amoncall/docs/design/product-definition-v0-2026-03-12.md#L11)

### UX / オペレータ体験: B

方向は正しいです。ambient surface と incident workspace の切り替えも実装されています。[AppShell.tsx](/Users/murase/project/3amoncall/apps/console/src/components/shell/AppShell.tsx#L71)

ただし `Codex` は、直近UIレビューで指摘した問題がまだ本質的に残っていると見ます。要約が速読しにくい、Immediate Action がまだ説明文寄り、Evidence Studio が raw-data viewer から十分脱し切れていない、という点です。[uiux-review-codex-2026-03-12.md](/Users/murase/project/3amoncall/docs/reviews/uiux-review-codex-2026-03-12.md#L20)

### アーキテクチャ: A

かなり良いです。ADR主導で、transport/domain/storage/UI の境界も保たれています。[develop-overall-review-2026-03-10.md](/Users/murase/project/3amoncall/docs/reviews/develop-overall-review-2026-03-10.md#L57)

`Codex` としては、今の主問題は architecture ではないと判断します。

### コード品質: B

テスト量と分離は強いです。今回確認できた範囲でも `42` テストファイル、`533` 件の `it/test` があります。

ただし、view model 層はまだ contract 不足を UI 側の圧縮で吸収している段階です。[adapters.ts](/Users/murase/project/3amoncall/apps/console/src/lib/viewmodels/adapters.ts#L18) さらに typecheck failure があるため、`Codex` はここを `高い` ではなく `良いが粗さあり` と評価します。

### AI / 診断品質: B-

`Codex` の見立てでは、ここはまだプロダクト定義の要求に追いついていません。診断 prompt は SRE 的には筋が良いですが、出力 contract は依然 `immediate_action: string` 中心で、`方針 / 操作 / 手順` の構造にはなっていません。[prompt.ts](/Users/murase/project/3amoncall/packages/diagnosis/src/prompt.ts#L122)

chat も visible evidence の意味深掘りというより、diagnosis summary に依存した補助回答です。[api.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/api.ts#L36)

### 運用 / リリース成熟度: B-

auth 方針や CI は整理されていますが、実運用の成熟度はまだコード成熟度より低いです。[develop-overall-review-2026-03-10.md](/Users/murase/project/3amoncall/docs/reviews/develop-overall-review-2026-03-10.md#L196)

また、ingest 側には open incidents 100件超での pagination 未対応や evidence append の競合更新リスクが残っています。[ingest.ts](/Users/murase/project/3amoncall/apps/receiver/src/transport/ingest.ts#L271)

## Codexが高く評価する点

- プロダクト定義が曖昧でなく、しかも実装に接続されていること
- ADR、レビュー、実装がバラバラに進んでいないこと
- ambient surface と incident workspace の二面性が、構想だけでなくコードに入っていること
- テストを書く文化が機能していること
- same-origin console, auth scoping, ambient read model などの判断が比較的筋が良いこと

## Codexが厳しく見る点

- `typecheck` が落ちている状態で品質を高評価のまま維持するのは無理です
- Immediate Action と recovery は、まだ product definition が求める粒度に届いていません
- Evidence Studio は proof-first の入口はあるが、意味単位での evidence 圧縮が弱いです
- chat は「逃げ道」としてはまだ薄く、summary bot 寄りです
- release/bundle/rollback の成熟が遅れており、プロダクト化の最後の壁になりやすいです

## Codex結論

`Codex` の結論として、3amoncall は「かなり質の高いプロダクト基盤」であり、方向性は正しいです。特に、プロダクト定義と実装の距離が短い点は強いです。ただし現段階では、まだ `完成度の高い障害対応プロダクト` ではなく、`優れた基盤 + 未完成の operator experience` です。

いま一番重要なのは新しい大きな構想ではなく、次の3点です。

1. `typecheck` failure を解消して、静的品質を回復する
2. `immediate_action` と `watch_items` を UI圧縮前提でなく contract として構造化する
3. operator の30秒理解に向けて、要約、action、evidence、chat の情報密度を再設計する
