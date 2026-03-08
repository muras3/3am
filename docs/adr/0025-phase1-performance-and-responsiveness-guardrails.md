# ADR 0025: Phase 1 Performance and Responsiveness Guardrails

- Status: Accepted
- Date: 2026-03-08

## Context

3amoncall の価値は、単に診断が正しいことではなく、**深夜 3 時でも素早く気持ちよく使えること** にある。  
このカテゴリでは、遅さ自体がプロダクト価値を損なう。

したがって Phase 1 では、堅牢性だけでなく **responsiveness-first** の非機能要件を明文化する必要がある。

## Decision

Phase 1 では、以下を performance / responsiveness guardrails とする。

### Console

- current incident detail は速く開くこと
- first viewport の主要情報は重い追加 fetch なしで描画できること
- Evidence Studio の切り替えは待たせすぎないこと
- UI は「AI を使っているから遅い」と感じさせないこと

### Diagnosis path

- incident 作成から diagnosis 開始までの経路は短く保つ
- GitHub Actions 起動のために不要な中継や polling を増やさない
- diagnosis result が返るまでの間も Console は incident を先に表示できること

### Architecture bias

Phase 1 の設計判断では、同程度に合理的な選択肢がある場合は、以下を優先する。

- fewer network hops
- thinner payloads
- fewer blocking dependencies
- faster first render
- explicit and cacheable reads

## Explicit Non-Goals

Phase 1 では、以下を優先しない。

- 過剰な抽象化による将来最適化
- 重厚な orchestration
- リアルタイム同期の完全性
- 低頻度ケースのための複雑な最適化

## Rationale

- incident console は 3am に使われるため、速度そのものが UX
- Receiver / Console / Actions の責務を分けても、待ち時間が長ければ体験が崩れる
- small team では、速さを失う抽象化は後から負債になりやすい

## Consequences

- Receiver は canonical store だが、read path は軽く保つ必要がある
- thin event と packet 分離は、payload と trigger の軽量化にも寄与する
- UI 実装では first viewport に必要なデータだけを優先表示する
- Sonnet などの実装エージェントは、機能追加時に responsiveness 低下を避ける判断を取る必要がある

## Related

- [0015-diagnosis-runtime-github-actions-with-cli-parity.md](/Users/murase/project/3amoncall/docs/adr/0015-diagnosis-runtime-github-actions-with-cli-parity.md)
- [0020-thin-event-contract-for-diagnosis-trigger.md](/Users/murase/project/3amoncall/docs/adr/0020-thin-event-contract-for-diagnosis-trigger.md)
- [0021-receiver-and-github-actions-integration.md](/Users/murase/project/3amoncall/docs/adr/0021-receiver-and-github-actions-integration.md)
- [incident-console-v3.html](/Users/murase/project/3amoncall/docs/mock/incident-console-v3.html)
