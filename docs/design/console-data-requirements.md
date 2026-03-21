# Console Data Requirements

Derived from:
- `docs/mock/lens-prototype-v1.html`
- `docs/product-concept-v0.2.md`

Purpose:
- Convert the validated console mock into concrete data requirements.
- Separate frontend rendering work from receiver-side evidence shaping and diagnosis-side reasoning.
- Make the gap from current code explicit.

## 1. Design-to-Data Mapping

### Normal

Role: runtime dependency map

UI needs:
- summary stats: active incidents, degraded nodes, cluster req/s, p95
- map nodes:
  - `id`
  - `tier`: `entry_point | runtime_unit | dependency`
  - `label`
  - `subtitle`
  - `status`: `healthy | degraded | critical`
  - `metrics`
  - `badges`
  - `incidentId?`
  - `positionHint?` or stable ordering key
- map edges:
  - `fromNodeId`
  - `toNodeId`
  - `kind`: `internal | external`
  - `status`: `healthy | degraded | critical`
  - `label?`
  - `trafficHint?`
- active incident list

Ownership:
- Receiver: node/edge derivation from observed spans
- Frontend: layout, animation, focus, navigation

### Incident

Role: decision room

UI needs:
- incident identity: id, severity, status, openedAt, duration
- headline
- action block:
  - `immediateAction`
  - `whyThisAction`
  - `doNot`
- blast radius:
  - affected targets
  - impact value per target
  - status per target
- confidence block:
  - confidence label
  - confidence value
  - evidence basis
  - key risk
- operator checks: checklist items
- root cause hypothesis
- causal chain:
  - ordered steps
  - typed step kind: `trigger | design_gap | cascade | impact`
- evidence entry:
  - counts
  - key timestamps summary

Ownership:
- Receiver: evidence counts, timestamps, impact primitives
- Diagnosis: headline, action, rationale, risk, operator checks, causal chain
- Frontend: hierarchy and visual emphasis only

### Evidence

Role: proof browser

UI needs:
- proof cards:
  - `id`
  - `label`
  - `status`
  - `summary`
  - `targetSurface`
  - `evidenceRefs`
- question/answer frame:
  - current question
  - grounded answer
  - evidence count summary
  - suggested follow-ups
- traces surface:
  - observed trace group
  - expected trace group
  - smoking-gun span id
  - span details
  - correlated logs for span
- metrics surface:
  - hypothesis groups
  - per-row observed value
  - expected value
  - deviation or ratio
  - projected value when answer is inferential
- logs surface:
  - claim clusters
  - signal entries
  - dimmed noise entries
  - absence evidence entries
- side notes:
  - confidence
  - uncertainty
  - affected dependencies

Ownership:
- Receiver: deterministic evidence retrieval, baseline retrieval, structured comparisons
- Diagnosis: proof semantics, verdicts, answer text, follow-up suggestions
- Frontend: tab state, expansion, highlighting, navigation

## 2. Preferred Data Contracts

### Normal API

Preferred endpoint:
- `GET /api/runtime-map`

Response shape:

```json
{
  "summary": {
    "activeIncidents": 2,
    "degradedNodes": 2,
    "clusterReqPerSec": 866,
    "clusterP95Ms": 89
  },
  "nodes": [
    {
      "id": "route:POST:/checkout",
      "tier": "entry_point",
      "label": "POST /checkout",
      "subtitle": "189 req/s",
      "status": "critical",
      "metrics": {
        "errorRate": 0.682
      },
      "badges": ["68% err"],
      "incidentId": "INC-0892"
    }
  ],
  "edges": [
    {
      "fromNodeId": "route:POST:/checkout",
      "toNodeId": "unit:StripeClient",
      "kind": "internal",
      "status": "critical",
      "label": null
    }
  ],
  "incidents": [
    {
      "incidentId": "INC-0892",
      "label": "Stripe Rate Limit Cascade",
      "severity": "critical",
      "openedAgo": "8m"
    }
  ]
}
```

### Incident API

Preferred source:
- extend `GET /api/incidents/:id`

Needed additions beyond current packet + diagnosis:
- `impactSummary`
- `blastRadius`
- `confidenceSummary`
- `evidenceSummary`

Response additions:

```json
{
  "impactSummary": {
    "startedAt": "2026-03-20T14:23:15Z",
    "fullCascadeAt": "2026-03-20T14:25:30Z",
    "diagnosedAt": "2026-03-20T14:27:45Z"
  },
  "blastRadius": [
    { "target": "payment-service", "status": "critical", "impactValue": 0.68, "label": "68%" },
    { "target": "order-service", "status": "degraded", "impactValue": 0.23, "label": "23%" }
  ],
  "confidenceSummary": {
    "label": "High confidence",
    "value": 0.85,
    "basis": "Stripe 429 correlates with traffic spike",
    "risk": "Backoff rollout without guard may cause retry storm"
  },
  "evidenceSummary": {
    "traces": 47,
    "traceErrors": 12,
    "metrics": 6,
    "logs": 234,
    "logErrors": 89
  }
}
```

### Evidence API

Preferred source:
- a dedicated endpoint, for example `GET /api/incidents/:id/evidence`

Reason:
- the UI now needs curated proof surfaces, not raw telemetry rows only

Response shape:

```json
{
  "proofCards": [],
  "qa": {
    "question": "Why are checkout payments failing?",
    "answer": "Stripe API rate limit exceeded...",
    "evidenceSummary": {
      "traces": 12,
      "metrics": 3,
      "logs": 28
    },
    "followups": []
  },
  "surfaces": {
    "traces": {
      "observed": [],
      "expected": [],
      "smokingGunSpanId": "..."
    },
    "metrics": {
      "hypotheses": []
    },
    "logs": {
      "claims": []
    }
  },
  "sideNotes": []
}
```

## 3. Contract Gaps To Close Before Task Breakdown

The sections above define the main shapes, but they are not yet sufficient for implementation.
The following contracts must be fixed before task breakdown starts.

### 3.1 Expected Behavior Contract

Required because the mock depends on `expected vs observed`.

Must decide:
- baseline source: same route, same service, same dependency path
- baseline window: relative lookback window and minimum sample size
- fallback behavior when no baseline exists
- whether expected values are receiver-derived or diagnosis-derived

Preferred shape:

```json
{
  "expected": {
    "windowStart": "2026-03-20T14:15:00Z",
    "windowEnd": "2026-03-20T14:22:59Z",
    "sampleCount": 42,
    "confidence": "high | medium | low"
  }
}
```

### 3.2 Runtime Map Derivation Contract

Required because `entry_point`, `runtime_unit`, and `dependency` cannot be guessed in the frontend.

Must decide:
- node classification rules
- stable node id rules
- edge deduplication rules
- collapse rules when multiple spans map to one node
- ordering or position hints so 1-3 nodes still look intentional

Preferred node shape:

```json
{
  "id": "unit:stripe-client",
  "tier": "runtime_unit",
  "source": {
    "kind": "span_name | http_route | peer_service | derived_group",
    "value": "StripeClient.charge"
  }
}
```

### 3.3 Blast Radius Contract

Required because the mock shows impact bars, not just affected service names.

Must decide:
- target unit: service, route, or mixed target types
- impact metric: error rate, impacted requests, latency degradation, or weighted score
- aggregation rules for `N other services ok`

Preferred shape:

```json
{
  "blastRadius": [
    {
      "targetId": "service:payment-service",
      "label": "payment-service",
      "status": "critical",
      "impactMetric": "error_rate",
      "impactValue": 0.68,
      "displayValue": "68%"
    }
  ],
  "rollup": {
    "healthyCount": 4,
    "label": "4 other services"
  }
}
```

### 3.4 Proof Card Reference Contract

Required because the UI needs deterministic links from proof cards to traces, metrics, and logs.

Must decide:
- card id scheme
- target surface scheme
- reference type per card
- highlight behavior when no exact raw row exists

Preferred shape:

```json
{
  "proofCards": [
    {
      "id": "trigger",
      "targetSurface": "traces",
      "evidenceRefs": [
        { "kind": "span", "id": "traceId:spanId" },
        { "kind": "log", "id": "service:timestamp:bodyHash" }
      ]
    }
  ]
}
```

### 3.5 Q&A Contract

Required because the mock is no longer a generic chat box.

Must decide:
- single-turn vs threaded state
- whether answer generation is deterministic or diagnosis-assisted
- how confidence is returned
- how evidence refs are attached
- what happens when the question cannot be answered

Preferred shape:

```json
{
  "qa": {
    "question": "Why are checkout payments failing?",
    "answer": "Stripe API rate limit exceeded...",
    "confidence": {
      "label": "high",
      "value": 0.85
    },
    "evidenceRefs": [
      { "kind": "proof_card", "id": "trigger" }
    ],
    "followups": ["Is there retry logic?"],
    "noAnswerReason": null
  }
}
```

### 3.6 Absence Evidence Contract

Required because `no retry / backoff` is not a raw row. It is a structured negative finding.

Must decide:
- pattern set to search for
- time window used for absence detection
- threshold for declaring absence
- whether absence findings belong to receiver or diagnosis

Preferred shape:

```json
{
  "claims": [
    {
      "id": "no-retry",
      "kind": "absence",
      "label": "No retry / backoff pattern found",
      "expected": "retry or backoff entries present during 429 responses",
      "observed": "0 matching entries",
      "supportingRefs": []
    }
  ]
}
```

### 3.7 Empty And Degraded State Contract

Required because the current mock assumes rich evidence always exists.

Must decide:
- diagnosis pending state
- insufficient baseline state
- sparse evidence state
- map with one node only
- no representative trace state

Preferred shape:

```json
{
  "state": {
    "diagnosis": "ready | pending | unavailable",
    "baseline": "ready | insufficient | unavailable",
    "evidenceDensity": "rich | sparse | empty"
  }
}
```

### 3.8 Old And New API Coexistence Contract

Required because the current codebase still serves old UI primitives.

Must decide:
- whether `/api/services` and `/api/activity` stay public
- whether raw telemetry endpoints remain first-class or become debugging-only
- whether `/api/chat/:id` is replaced, wrapped, or left as internal legacy
- migration plan for `PlatformEventsView`

Minimum rule:
- new console paths consume curated endpoints first
- raw endpoints remain optional support paths, not the primary UI contract

## 4. Current Code Snapshot

### Already Exists

- Incident detail already carries `packet` plus `diagnosisResult`.
- Packet already includes:
  - `window`
  - `scope`
  - `triggerSignals`
  - `changedMetrics`
  - `representativeTraces`
  - `relevantLogs`
- Snapshot rebuild already computes baseline metrics internally for scoring.
- Telemetry APIs already expose incident-bound spans, raw metrics, and correlated/contextual logs.

### Missing for the Validated Mock

#### Normal

- No node/edge runtime map model exists.
- Ambient API only exposes flat `ServiceSurface[]` plus recent activity.
- No route-level or dependency-level aggregation for the overview map.

#### Incident

- No explicit blast-radius model exists.
- No explicit confidence/risk summary exists as a normalized API shape.
- Evidence time summary is only partially derivable from `packet.window` and current diagnosis metadata.

#### Evidence

- No curated evidence endpoint exists.
- `TracesView` renders generic trace groups from raw telemetry only.
- `MetricsView` renders a generic chart/table/bar view from raw metrics.
- `LogsView` renders a filterable chronological table from raw logs.
- No expected-vs-observed trace pairing is returned.
- No hypothesis-grouped metrics are returned.
- No claim-clustered logs are returned.
- No absence evidence is returned.
- Q&A is currently a generic chat endpoint, not a grounded proof query surface.

## 5. Ownership By Layer

### Frontend

Should own:
- navigation
- animation
- expansion/collapse state
- proof-card highlighting
- local tab state

Should not own:
- map inference
- expected-vs-observed comparison logic
- claim clustering
- absence evidence detection
- blast-radius computation

### Receiver

Should own:
- runtime map derivation from observed spans
- deterministic impact summaries
- baseline retrieval
- expected-vs-observed comparison data
- evidence clustering primitives
- evidence counts and timestamps

### Diagnosis

Should own:
- action wording
- rationale wording
- proof-card semantics
- verdict labels
- grounded answer text
- suggested follow-up questions

## 6. Gap Matrix

| Requirement | Current state | Gap | Primary owner |
|-------------|---------------|-----|---------------|
| Runtime dependency map | Flat services + activity feed | Major | Receiver |
| Blast radius block | Not modeled explicitly | Medium | Receiver |
| Confidence with risk summary | Partially embedded in diagnosis text | Medium | Diagnosis |
| Expected vs observed traces | Incident-only spans returned | Major | Receiver |
| Hypothesis-grouped metrics | Raw metric table/chart only | Major | Receiver |
| Claim-clustered logs | Raw chronological log rows only | Major | Receiver |
| Absence evidence | Not modeled | Major | Receiver |
| Grounded Q&A with evidence refs | Generic `/api/chat/:id` only | Major | Diagnosis |
| Platform removed from primary evidence | Platform tab still exists in code | Medium | Frontend + Receiver |

## 7. Recommended Next Step

Do not start by rewriting the frontend.

Do this first:
1. Define the new data contracts for `runtime-map`, `incident impact summary`, and `evidence proof surfaces`
2. Decide which fields are deterministic receiver output vs diagnosis output
3. Add API fixtures for those shapes
4. Only then adapt console components to consume them
