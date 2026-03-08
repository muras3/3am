# Incident Console Figma Brief

## Goal

3amoncall の Incident Console を、Datadog / New Relic / Dynatrace / incident.io / PagerDuty に負けない UI/UX で Figma に落とす。

主画面は **incident-first**。  
画面を開いた 5 秒以内に、以下が分かることを最優先にする。

- 何が起きているか
- 今なにをすべきか
- なぜその action が妥当か

その上で、必要に応じて metrics / trace / logs / platform logs を **美しく、実データ感のある形で** 検証できること。

## Hard Constraints

- `1440x900` desktop first
- first viewport で重要情報を見せる
- ページ全体の縦スクロールは禁止
- light theme ベース
- generic dashboard ではなく incident console
- AI chat は incident 文脈に埋め込む
- metrics はチャートで見せる
- traces は APM / waterfall 的に見せる
- platform logs は application logs と区別する

## Primary Direction

現在の主案は **A. Board + Studio**。

構成:

- 左: incident list
- 中央: Incident Board
- 右: compact AI chat
- `Open Evidence Studio` で overlay を開き、metrics / trace / logs / pf logs を切り替える

## What Must Be On The Incident Board

- `What happened`
- `Immediate Action`
- `Why this action`
- `Root cause hypothesis`
- `Operator check`
- `Do not`
- `Open Evidence Studio`

`What to do now` と `Immediate Action` の重複は避ける。  
設計者向け説明文や補足パネルは UI に出さない。

## Reference Inputs

### Local mock

- [docs/mock/incident-console-concepts.html](/Users/murase/project/3amoncall/docs/mock/incident-console-concepts.html)

### Official references

- Datadog Trace View
  - https://docs.datadoghq.com/tracing/trace_explorer/trace_view/
- Datadog Log Side Panel
  - https://docs.datadoghq.com/logs/explorer/side_panel/
- Datadog Issue Correlation with Error Tracking
  - https://docs.datadoghq.com/error_tracking/issue_correlation/
- Datadog Trace Explorer
  - https://docs.datadoghq.com/tracing/trace_explorer/

- New Relic Errors Inbox docs
  - https://docs.newrelic.com/docs/errors-inbox/errors-inbox/
- New Relic Errors Inbox product page
  - https://newrelic.com/platform/errors-inbox
- New Relic version tracking screenshot doc
  - https://docs.newrelic.com/docs/errors-inbox/version-tracking/

- Dynatrace Problems app
  - https://docs.dynatrace.com/docs/dynatrace-intelligence/davis-problems-app

- incident.io alert grouping and incident creation
  - https://help.incident.io/articles/4007103429-creating-escalations-and-incidents-from-alerts

- PagerDuty incidents page
  - https://support.pagerduty.com/main/docs/navigate-the-incidents-page
- PagerDuty incident timeline
  - https://support.pagerduty.com/main/docs/incidents

## What To Borrow From Each Product

- Datadog
  - dense but readable information layout
  - logs / traces / issue details feel real, not decorative
  - query/facet/explorer mental model
- New Relic
  - error group detail structure
  - logs in context / trace in context
- Dynatrace
  - problem-first framing
  - root cause + impact in one view
- incident.io
  - incident object as the center of the page
  - AI-supported summary / grouping sensibility
- PagerDuty
  - incident timeline clarity
  - urgency / action orientation

## Design Intent

The UI should feel:

- premium
- solid
- calm under pressure
- opinionated
- operationally credible

It should **not** feel:

- like a rough engineer mock
- like a crypto dashboard
- like a generic admin panel
- like a marketing AI product with purple gradients

## Specific UX Requirements

### 1. First-view understanding

Within 5 seconds, the user should understand:

- the incident headline
- blast radius / impact
- the immediate action

### 2. Reasoning visibility

`Why this action` should be accessible without losing context.

Preferred options:

- inline if it fits cleanly in first viewport
- otherwise lightweight overlay within same screen context

### 3. Evidence realism

Evidence Studio must feel like real production tooling:

- metrics: real timeseries charts, not placeholder KPI tiles
- traces: waterfall with span names and durations
- logs: explorer-like rows with timestamps, source, message, meaning
- platform logs: separate visual language from app logs

### 4. AI integration

AI chat should feel embedded, like a copilot within the incident, not a random chatbot bolted onto the page.

## Open Questions For Figma Exploration

- Is `Why this action` better inline or overlay?
- Should AI chat remain on the right, or be collapsed until invoked?
- Does the incident list deserve permanent left presence, or should it be compressed further?

## Deliverable Requested In Figma

Please produce:

1. a high-fidelity desktop screen for the primary Incident Board
2. a high-fidelity Evidence Studio overlay
3. one alternate variant if the first attempt still feels too dashboard-like

## Suggested Figma Prompt

```text
Design a premium, white-based incident console for 3amoncall.

Use Datadog, New Relic, Dynatrace, incident.io, and PagerDuty as reference inputs.
The strongest visual reference should be Datadog.

The product is an OSS incident diagnosis tool for small teams.
The main screen is incident-first, not a generic observability dashboard.

Constraints:
- 1440x900 desktop
- no page-level vertical scroll
- first viewport must show what happened, immediate action, and why the action is correct
- AI chat is embedded in the incident context
- metrics must be real timeseries charts
- traces must look like APM waterfalls
- logs must look like production log explorer rows
- platform logs must be visually distinct from app logs
- white/light theme only

Required information:
- What happened
- Immediate Action
- Why this action
- Root cause hypothesis
- Operator check
- Do not
- Open Evidence Studio

Evidence Studio:
- overlay or drawer
- metrics / trace / logs / platform logs tabs
- feel as credible as Datadog/New Relic

Avoid:
- generic admin dashboard
- excessive empty space
- duplicated content
- purple AI gradients
- low-fidelity placeholder charts
```
