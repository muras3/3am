# ADR 0018: Incident Packet Semantic Sections

- Status: Accepted
- Date: 2026-03-08

## Context

ADR 0016 で `incident packet v1alpha` の最小構成は置いたが、Phase 1 実装を進めるには field 名より前に **packet がどの意味層を持つか** を固定する必要がある。

UI の最終レイアウトは今後も変わりうるため、packet を UI の見た目に直接従属させるのは避けたい。  
一方で、Receiver・GitHub Actions・CLI・Console が同じ incident を指しているためには、packet が安定した canonical model を持つ必要がある。

## Decision

`incident packet` は **LLM input 用の canonical incident model** とする。  
UI 専用 schema ではなく、以下の semantic sections を持つ。

### 1. `identity`

incident を incident として識別するための層。

含めるもの:

- `incident_id`
- `packet_id`
- `schema_version`
- `status`
- `severity`
- `opened_at`
- `window`
- `scope`

### 2. `situation`

incident の事実ベースの状況説明層。

含めるもの:

- visible symptoms
- affected services / routes / dependencies
- trigger signals
- impact surface
- deployment / config / traffic context の要約的事実

ここは **deterministic facts** を主とし、自然言語の完成要約までは packet の責務にしない。

### 3. `evidence`

incident を裏づける観測データの層。

含めるもの:

- changed metrics
- representative traces
- relevant logs
- platform facts
- raw artifact pointers

この層は packet の中核であり、LLM への主な入力となる。

### 4. `retrieval`

packet から raw data や保存済み artifact へ戻るための層。

含めるもの:

- trace refs
- log refs
- metric refs
- platform log refs
- optional URLs or storage keys

`retrieval` は UI deep dive と replay の両方を支える。

## Explicit Non-Goals

`incident packet` には、以下を含めない。

- `immediate_action`
- `do_not`
- `root_cause_hypothesis`
- `why_this_action`
- `confidence_assessment`
- UI 固有の card 名や表示順

これらは `diagnosis result` または UI view model の責務であり、packet 自体には入れない。

## Rationale

- packet の元の目的は **LLM に渡すための deterministic incident input** である
- recommendation や reasoning を packet に入れると、Receiver が LLM 的責務を持ってしまう
- semantic sections を固定すれば、UI が多少変わっても packet の安定性を保てる
- Console, CLI, GitHub Actions が同じ canonical model を参照できる

## Consequences

- Receiver は `identity / situation / evidence / retrieval` を作る責務を持つ
- `diagnosis result` は packet とは別の出力契約として定義する必要がある
- UI は packet をそのまま描画するのではなく、packet を土台に表示モデルを構成する
- field 詳細は今後更新されうるが、semantic sections 自体は Phase 1 の基礎契約になる

## Related

- [0016-incident-packet-v1alpha.md](/Users/murase/project/3amoncall/docs/adr/0016-incident-packet-v1alpha.md)
- [0017-incident-formation-rules-v1.md](/Users/murase/project/3amoncall/docs/adr/0017-incident-formation-rules-v1.md)
- [incident-console-v3.html](/Users/murase/project/3amoncall/docs/mock/incident-console-v3.html)
