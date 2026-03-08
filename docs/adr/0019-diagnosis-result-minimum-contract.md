# ADR 0019: Diagnosis Result Minimum Contract

- Status: Accepted
- Date: 2026-03-08

## Context

ADR 0018 で `incident packet` は LLM input 用の canonical model として整理された。  
次に必要なのは、GitHub Actions などの diagnosis runtime が LLM 実行後に **何を Receiver に返すか** の出力契約である。

この契約が未定だと、次の実装が不安定になる。

- Receiver の保存モデル
- Console の incident detail 表示
- CLI / replay での結果比較
- 再診断やモデル差し替え時の出力整合

Phase 1 では、`docs/mock/incident-console-v3.html` を MVP の UI basis とする。  
したがって diagnosis result は、その画面が本当に必要としている表示要素だけを持てばよい。

## Decision

`diagnosis result` は `incident packet` とは別の出力契約とする。  
最小 contract は以下の semantic sections を持つ。

### 1. `summary`

incident の解釈結果を短く伝える層。

含めるもの:

- `what_happened`
- `root_cause_hypothesis`

### 2. `recommendation`

最初に取るべき行動を伝える層。

含めるもの:

- `immediate_action`
- `action_rationale_short`
- `do_not`

### 3. `reasoning`

recommendation に至った因果説明の層。

含めるもの:

- `causal_chain`
  - 3-5 ステップ程度
  - 各ステップは `type`, `title`, `detail` を持つ

### 4. `operator_guidance`

アクション後に何を見るべきかを伝える層。

含めるもの:

- `watch_items`
- `operator_checks`

### 5. `confidence`

診断の確からしさと限界を伝える層。

含めるもの:

- `confidence_assessment`
- `uncertainty`

### 6. `metadata`

1 回の diagnosis 実行を識別する層。

含めるもの:

- `incident_id`
- `packet_id`
- `model`
- `prompt_version`
- `created_at`

## Example Shape

```json
{
  "incident_id": "inc_123",
  "packet_id": "pkt_123",
  "model": "claude-sonnet-4.6",
  "prompt_version": "v5",
  "created_at": "2026-03-08T12:00:00Z",
  "summary": {
    "what_happened": "Stripe 429s spilled into queue saturation and checkout 504s.",
    "root_cause_hypothesis": "Dependency rate limiting was amplified by local fixed retries in the shared worker pool."
  },
  "recommendation": {
    "immediate_action": "Disable fixed retries and shed checkout traffic.",
    "action_rationale_short": "Retry suppression is the fastest control point to reduce blast radius.",
    "do_not": "Do not restart blindly."
  },
  "reasoning": {
    "causal_chain": [
      { "type": "external", "title": "Stripe 429", "detail": "rate limit begins" },
      { "type": "system", "title": "Retry loop", "detail": "shared pool amplifies failure" },
      { "type": "incident", "title": "Queue climbs", "detail": "local overload emerges" },
      { "type": "impact", "title": "Checkout 504", "detail": "customer-visible failure" }
    ]
  },
  "operator_guidance": {
    "watch_items": [
      { "label": "Queue", "state": "must flatten first", "status": "watch" },
      { "label": "504 rate", "state": "should stop rising", "status": "next" }
    ],
    "operator_checks": [
      "Confirm queue depth flattens within 30s",
      "Confirm 504 rate stops rising within 3-5 minutes"
    ]
  },
  "confidence": {
    "confidence_assessment": "High confidence this is external-origin, not rollout-origin.",
    "uncertainty": "Stripe quota bucket behavior is not directly visible in telemetry."
  }
}
```

## Explicit Non-Goals

`diagnosis result` には、以下を含めない。

- raw metrics / raw traces / raw logs
- packet の複製
- UI 固有のレイアウト情報
- 長い chain-of-thought

## Rationale

- `v3` の Incident Board は recommendation と reasoning を短く要求している
- deep dive 用の raw data は `incident packet` と `Evidence Studio` 側の責務である
- 最小 contract に絞ることで model 比較と再診断を扱いやすくなる
- output 契約を分離することで packet の安定性を守れる

## Consequences

- Console は `packet + diagnosis result` を合成して incident detail を描画する
- GitHub Actions はこの contract を守って Receiver に返す必要がある
- Receiver は diagnosis result を packet とは別に保存する
- field 名の微調整はありえるが、semantic sections は Phase 1 の基礎契約になる

## Related

- [0018-incident-packet-semantic-sections.md](/Users/murase/project/3amoncall/docs/adr/0018-incident-packet-semantic-sections.md)
- [0015-diagnosis-runtime-github-actions-with-cli-parity.md](/Users/murase/project/3amoncall/docs/adr/0015-diagnosis-runtime-github-actions-with-cli-parity.md)
- [incident-console-v3.html](/Users/murase/project/3amoncall/docs/mock/incident-console-v3.html)
