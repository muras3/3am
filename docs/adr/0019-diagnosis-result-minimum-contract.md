# ADR 0019: Diagnosis Result Minimum Contract

- Status: Accepted
- Date: 2026-03-08
- **Revised: 2026-03-16 — v2: operational resilience + output constraints**

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

### v2 追記: なぜ改訂が必要か

v1 は出力の **shape** を定めた。しかし実運用で必要な以下の 3 点がスコープ外だった。

1. **LLM 呼び出しの耐障害性** — callModel に retry も timeout もない。Anthropic API の 529（過負荷）やネットワーク断で診断が全損する。GitHub Actions は最大 6 時間ジョブを保持するため、hung call が silent failure になる
2. **出力サイズの制約** — causal_chain の配列長、文字列フィールドの最大長に制約がない。LLM が冗長な出力を返した場合、保存・表示・転送すべてに影響する
3. **プロンプトへのユーザー制御データ埋め込み** — platformEvents の `details` フィールドが `z.record(z.string(), z.unknown())` で、`JSON.stringify()` のままプロンプトに埋め込まれている。攻撃者がプラットフォームイベントの詳細を制御できる場合、プロンプトインジェクションが成立する

いずれも packet remediation（B-2〜B-6）で入力品質が上がった今、出力側の堅牢化が次のボトルネックになっている。

## Decision

### 出力契約 (v1 から変更なし)

`diagnosis result` は `incident packet` とは別の出力契約とする。
最小 contract は以下の semantic sections を持つ。

#### 1. `summary`

incident の解釈結果を短く伝える層。

- `what_happened`
- `root_cause_hypothesis`

#### 2. `recommendation`

最初に取るべき行動を伝える層。

- `immediate_action`
- `action_rationale_short`
- `do_not`

#### 3. `reasoning`

recommendation に至った因果説明の層。

- `causal_chain`
  - 3-5 ステップ程度
  - 各ステップは `type`, `title`, `detail` を持つ

#### 4. `operator_guidance`

アクション後に何を見るべきかを伝える層。

- `watch_items`
- `operator_checks`

#### 5. `confidence`

診断の確からしさと限界を伝える層。

- `confidence_assessment`
- `uncertainty`

#### 6. `metadata`

1 回の diagnosis 実行を識別する層。

- `incident_id`
- `packet_id`
- `model`
- `prompt_version`
- `created_at`

### 出力サイズ制約 (v2 追加)

LLM 出力は非決定的であり、contract shape を満たしても冗長な出力が保存・表示を圧迫しうる。
parseResult は Zod validation 後に以下の上限を **超過した場合 truncate ではなく reject** する。

| フィールド | 上限 | 根拠 |
|---|---|---|
| `causal_chain` 配列長 | 最大 8 ステップ | 因果チェーンが 8 を超える場合、LLM が要約に失敗している |
| `watch_items` 配列長 | 最大 10 | operator が一度に監視できる上限 |
| `operator_checks` 配列長 | 最大 10 | 同上 |
| 各 string フィールド | 最大 2,000 文字 | Console の表示想定 + 保存効率 |
| `CausalChainStep.detail` | 最大 500 文字 | 1 ステップの詳細が長すぎると可読性が壊れる |

reject された場合、診断は失敗として扱い、retry 対象にはしない（LLM 出力の構造問題であり、再試行で改善しない可能性が高い）。

### LLM 呼び出しの耐障害性 (v2 追加)

`callModel` は以下のポリシーで retry と timeout を実装する。

#### Timeout

- 単一 API 呼び出しに **120 秒の timeout** を設定する（`AbortController`）
- 根拠: 正常な診断応答は 10-30 秒。120 秒は十分な余裕を持った上限

#### Retry

- **最大 2 回リトライ** (初回 + 2 回 = 計 3 回試行)
- exponential backoff: 1 秒 → 2 秒 (base × 2^attempt)
- **リトライ対象**: timeout、ネットワークエラー、HTTP 429 (rate limit)、HTTP 529 (overloaded)
- **リトライ対象外**: HTTP 400/401/403 (client error)、JSON parse 失敗、Zod validation 失敗
- 全リトライ失敗時は最後のエラーを throw する

#### CLI callback POST

CLI の `--callback-url` POST も同じリトライポリシーを適用する。
診断結果が生成済みなのに callback 失敗で消失するのは最悪のケースであり、リトライする価値がある。

### プロンプトセキュリティ (v2 追加)

LLM プロンプトに埋め込まれるユーザー制御データには、以下の防御を適用する。

#### platformEvents.details のサニタイズ

- `details` フィールドの値を `JSON.stringify()` 後、結果文字列を **最大 1,000 文字で切り詰める**
- 切り詰めた場合は末尾に `" [truncated]"` を付加する
- 根拠: details は補助情報であり、長大なペイロードは情報密度を下げるだけ

#### 共通ルール

- プロンプトに埋め込む全フィールドの合計文字数に **上限を設けない** (packet schema 側のサイズ制御が primary defense)
- フィールド値内の markdown / XML-like タグについて、Phase 1 ではエスケープしない。LLM の instruction following で十分と判断する
- この判断は Phase 2 で再評価する（chat 機能でのユーザー入力プロンプトは別途 ADR が必要）

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

### v2 追記: 見送った選択肢

以下は検討したが v2 では見送った。

- **`immediate_action` のオブジェクト構造化** (policy / operation / procedure への分解) — Codex レビューで指摘された。しかし現在の 3 フィールド (`immediate_action` + `action_rationale_short` + `do_not`) は Console の ActionVM (`primaryText` / `rationale` / `doNot`) に 1:1 で対応しており、validation 5 シナリオで 7.4/8 のスコアを出している。`immediate_action` string をさらに分解すると、LLM の出力制御コストが上がり、parse 失敗率が増える。Phase 1 では現行 shape を維持し、Phase 2 で operator フィードバックを見て再検討する
- **モデル fallback チェーン** (primary model 失敗時に secondary model にフォールバック) — 実装複雑性に対して Phase 1 での価値が低い。retry で十分
- **プロンプト内の XML/markdown エスケープ** — 現行の temperature: 0 + strict JSON output 指示で instruction following は十分。chat 経路（ユーザー入力あり）は別 ADR で扱う

## Rationale

- `v3` の Incident Board は recommendation と reasoning を短く要求している
- deep dive 用の raw data は `incident packet` と `Evidence Studio` 側の責務である
- 最小 contract に絞ることで model 比較と再診断を扱いやすくなる
- output 契約を分離することで packet の安定性を守れる

### v2 追記

- retry + timeout は「診断が来ない」を防ぐ最小の運用耐性。Phase 1 で platform deploy する前提条件
- 出力サイズ制約は「LLM が暴走しても保存・表示が壊れない」ためのガードレール
- prompt サニタイズは platform events という外部入力経路に対する最小限の防御

## Consequences

- Console は `packet + diagnosis result` を合成して incident detail を描画する
- GitHub Actions はこの contract を守って Receiver に返す必要がある
- Receiver は diagnosis result を packet とは別に保存する
- field 名の微調整はありえるが、semantic sections は Phase 1 の基礎契約になる

### v2 追記

- `callModel` に retry + timeout を実装する必要がある (`packages/diagnosis/src/model-client.ts`)
- `parseResult` に出力サイズバリデーションを追加する必要がある (`packages/diagnosis/src/parse-result.ts`)
- `buildPrompt` で platformEvents.details を切り詰める必要がある (`packages/diagnosis/src/prompt.ts`)
- CLI の callback POST にもリトライを実装する必要がある (`packages/cli/src/index.ts`)
- 既存の 542 テストに影響はない（追加テストが必要）

## Related

- [0018-incident-packet-semantic-sections.md](/Users/murase/project/3am/docs/adr/0018-incident-packet-semantic-sections.md)
- [0015-diagnosis-runtime-github-actions-with-cli-parity.md](/Users/murase/project/3am/docs/adr/0015-diagnosis-runtime-github-actions-with-cli-parity.md)
- [incident-console-v3.html](/Users/murase/project/3am/docs/mock/incident-console-v3.html)

## Changelog

- **v1 (2026-03-08)**: Initial contract — output shape + semantic sections
- **v2 (2026-03-16)**: Added operational resilience (retry/timeout), output size constraints, prompt security rules. Documented rejected alternatives (immediate_action decomposition, model fallback chain, prompt escaping)
