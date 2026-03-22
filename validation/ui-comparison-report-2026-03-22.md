# UI Comparison Report: Mock vs Production

**Date**: 2026-03-22
**Mock**: `docs/mock/lens-prototype-v1.html`
**Production**: `https://3amoncall.vercel.app`
**Incident**: `inc_8e390cb6-4133-480d-b479-f3c403ff6168`
**Screenshots**: `/tmp/comparison/`

---

## Summary

| Level | Mock | Production | Match |
|-------|------|-----------|-------|
| L0 Map — Stats Bar | 4 stats (2/2/866/89ms) | 4 stats (6/5/0/0ms) | Structural OK, values wrong |
| L0 Map — Dependency Graph | 3-tier, 7 nodes, animated edges | 2-tier, 5 nodes, static edges | Major gaps |
| L0 Map — Incident Strip | 2 incidents, descriptive names | 6 incidents, generic "validation-web" | Structural OK, content gap |
| L1 Board — Action Hero | Concise single action | Numbered multi-step paragraph | Structural OK, formatting gap |
| L1 Board — Context Grid | Blast/Confidence/Operator 3-col | Present but cramped | Close |
| L1 Board — Causal Chain | 4-step typed flow | Present | Close |
| L1 Board — Evidence Entry | Counts + "Open Evidence Studio" | Present | OK |
| L2 Evidence — Proof Cards | 3 cards (Trigger/Design/Recovery) | **EMPTY** | **CRITICAL** |
| L2 Evidence — Q&A Frame | Question + Answer + Follow-ups | **MISSING** | **CRITICAL** |
| L2 Evidence — Traces | Waterfall + smoking gun + baseline | Flat text list, no styling | **CRITICAL** |
| L2 Evidence — Metrics | Hypothesis groups + bars | Flat text list, no styling | **CRITICAL** |
| L2 Evidence — Logs | Claim clusters + absence evidence | Flat text list, no styling | **CRITICAL** |
| L2 Evidence — Side Rail | Confidence/Uncertainty/Deps | **MISSING** | **CRITICAL** |
| Navigation — Zoom Nav | Dots before labels | No dots | Minor |
| Navigation — Deep Link | N/A | **BROKEN** (page.goto loses L1/L2) | **BUG** |

---

## Level 0 — Map (System Topology)

### L0-01: Entry Points tier is empty
- **Mock**: 3 entry point nodes (POST /checkout, GET /orders, GET /health) in the top tier
- **Production**: No nodes in the Entry Points tier — all nodes appear in the Runtime Units tier
- **Impact**: The 3-tier visual hierarchy (Entry Points → Runtime Units → Dependencies) collapses to 2 tiers
- **Root cause**: Likely the runtime-map API's tier classification logic doesn't assign any nodes as `entry_point`
- **Screenshot**: `prod_L0_map.png` vs `mock_L0_map.png`

### L0-02: Stats bar shows 0 Req/s and 0ms P95
- **Mock**: 866 Req/s, 89ms P95 Latency
- **Production**: 0 Req/s, 0ms P95
- **Impact**: Stats bar is misleading — shows zero throughput during an active incident with 6 incidents
- **Root cause**: The `summary` endpoint may not be computing aggregate request rates from SpanBuffer

### L0-03: No animated edge particles
- **Mock**: SVG edges with animated dot particles flowing along paths, with labels like "timeout"
- **Production**: Simple dashed lines between nodes, no animation or labels
- **Impact**: Loses the visual cue of traffic flow direction and volume

### L0-04: Map legend position differs
- **Mock**: Legend below the map graph
- **Production**: Legend above the map graph, between the title and the graph
- **Impact**: Minor layout difference

### L0-05: Node badges and contextual detail missing
- **Mock**: Nodes show diagnostic badges ("no batching") and contextual detail ("189 calls/s — 1:1 per tx", "429 — quota 0/100")
- **Production**: Nodes show only basic metrics (req/s + err%), no contextual badges or detail text
- **Impact**: Map loses its diagnostic value — just shows raw numbers without insight

### L0-06: Incident strip shows generic labels
- **Mock**: Descriptive names ("Stripe Rate Limit Cascade", "Elevated latency on order-service"), short IDs (INC-0892), mixed severity (Critical + Medium)
- **Production**: All incidents labeled "validation-web", full UUID IDs (INC-8E390CB6-...), all "critical"
- **Impact**: Can't distinguish incidents at a glance; the label should be the diagnosis headline, not the service name

### L0-07: Only 1 dependency node
- **Mock**: 2 dependencies (Stripe API, PostgreSQL) — shows both affected and healthy external systems
- **Production**: 1 dependency (stripe) — healthy dependencies aren't shown
- **Impact**: Incomplete picture of system topology

### L0-08: Zoom nav missing dots
- **Mock**: `● Map › ● Incident › ● Evidence` — each crumb has a status dot
- **Production**: `Map › Incident › Evidence` — no dots
- **Impact**: Minor visual difference
- **Code**: `ZoomNav.tsx` doesn't render `<span className="zn-dot">` elements

### L0-09: env-tag has visible border
- **Production**: `production` label has a border/background
- **Mock**: Plain text without border
- **Impact**: Minor styling difference

---

## Level 1 — Incident Board

### L1-01: Deep-link navigation is broken (BUG)
- **Symptom**: Navigating via URL `?incidentId=...&level=1` shows "Select an incident from the map" instead of the incident board
- **Works when**: Clicking an incident row in the strip (SPA navigation)
- **Root cause**: Full page navigation (`page.goto`) reloads the app. The `SetupGate` runs first, and by the time the router parses search params, the API might respond with 404 (cold start / serverless function initialization loses SpanBuffer context). Also, incident lookup may fail because the persistent store query differs from the in-memory path.
- **Impact**: Bookmarks, shared links, and browser refresh all break L1/L2 views

### L1-02: Headline is diagnosis narrative, not concise summary
- **Mock**: "Stripe API rate limit cascade causing payment failures across all checkout flows"
- **Production**: "Stripe's mock payment API began rate-limiting requests (HTTP 429) at 00:28:062, causing validation-web to exhaust its retry budget (5 attempts per order) and back up its worker pool and queue..."
- **Impact**: The headline is too long — reads like a diagnosis summary rather than a scannable headline

### L1-03: Action text is verbose numbered list
- **Mock**: Single concise sentence — "Enable request batching on StripeClient and add exponential backoff with jitter"
- **Production**: Numbered multi-step paragraph — "1) Immediately implement exponential backoff... 2) Shed load at the queue level... 3) Contact Stripe... 4) If queue and worker pool remain saturated..."
- **Impact**: The action hero loses its "single immediate action" emphasis; reads like a runbook

### L1-04: "Do not" section not visible
- **Mock**: Clearly shows `Do not: Request a Stripe rate limit increase — this masks the underlying design flaw`
- **Production**: The "Do not" warning may be present but is not prominently visible in the action hero card
- **Impact**: Critical safety warning may be missed

### L1-05: Chips are less descriptive
- **Mock**: "68% checkout errors", "Stripe 429", "payment-service", "order-service"
- **Production**: "75%", "http_429", "stripe"
- **Impact**: Chips should be human-readable at a glance, not raw metric names

### L1-06: Blast radius uses raw node IDs
- **Mock**: "payment-service", "order-service", "4 other services"
- **Production**: "unknown_service:node", "validation-web"
- **Impact**: "unknown_service:node" is meaningless to an operator

### L1-07: Incident ID display format
- **Mock**: Short "INC-0892" — scannable
- **Production**: Full UUID "INC-8e390cb6-4133-480d-b479-f3c403ff6168" — too long for header
- **Code**: `LevelHeader.tsx:54` — `incidentId.replace("inc_", "INC-")` just swaps prefix
- **Impact**: Header becomes cluttered

### L1-08: Severity badge not styled
- **Mock**: Colored badge with dot (`sev sev-critical` class)
- **Production**: Header shows ID but severity badge may not use the correct CSS classes (`severity-badge` vs mock's `sev sev-critical`)
- **Impact**: Severity isn't visually emphasized

---

## Level 2 — Evidence Studio

### L2-01: Proof cards are empty (CRITICAL)
- **Mock**: 3 proof cards — External Trigger (Confirmed), Design Gap (Confirmed), Recovery Signal (Inferred) — each with icon, summary, and status badge
- **Production**: `proofCards: []` from API — nothing renders
- **Root cause**: The receiver's evidence endpoint returns an empty proof cards array. The proof card generation (§3.4 in console-data-requirements.md) is not implemented in the receiver
- **Impact**: The key navigational element of Evidence Studio is absent

### L2-02: Q&A frame is missing (CRITICAL)
- **Mock**: Full Q&A frame — question input, grounded answer with teal background, evidence note ("12 traces, 3 metrics, 28 logs"), and 4 follow-up chip buttons
- **Production**: No Q&A frame visible. The API returns `qa: null`
- **Root cause**: The Q&A contract (§3.5) is not implemented. Diagnosis Stage 2 doesn't exist yet
- **Impact**: The evidence-grounded questioning capability — a core UX differentiator — is absent

### L2-03: "Diagnosis not available yet" shown incorrectly
- **Production**: Shows "Diagnosis not available yet. Evidence is being collected." even though the API returns `state.diagnosis: "ready"` and diagnosis data IS present in the incident detail
- **Root cause**: The Evidence Studio component may be checking for proof cards or QA data to determine diagnosis availability, not the `state.diagnosis` field
- **Impact**: Misleading status message when diagnosis exists but proof cards don't

### L2-04: Traces view is unstyled flat text (CRITICAL)
- **Mock**: Full waterfall visualization — trace header with route/status/duration, colored span bars (gantt chart), highlighted smoking gun span with expanded attributes, correlated logs inline, baseline comparison toggle
- **Production**: Plain text list — "stripe.charge tid:abbaf2fd429 252ms" followed by span names and durations, no visual structure
- **Missing features**:
  - Waterfall span bars (`.span-bar-track`, `.span-bar`)
  - Smoking gun highlight (`.smoking-gun`)
  - Trace header with error status styling (`.trace-header.error-header`)
  - Span attribute expansion (`.span-detail`)
  - Correlated logs section (`.sd-linked-log`)
  - Baseline trace toggle (`.baseline-toggle`)
  - Evidence annotation (`.ev-annotation`)

### L2-05: Metrics view is unstyled flat text (CRITICAL)
- **Mock**: Hypothesis-grouped metrics — 3 groups (Trigger/Cascade/Recovery), each with typed header, verdict badge, metric rows with name/value/bar/expected comparison
- **Production**: Plain text list — metric names with values, no grouping or bars
- **Missing features**:
  - Hypothesis group containers (`.hyp-group`)
  - Typed headers with color coding (`.hyp-header.trigger`, `.cascade`, `.recovery`)
  - Verdict badges ("Confirmed", "Inferred")
  - Visual metric bars (`.hyp-metric-bar`, `.hyp-metric-fill`)
  - Expected value comparison (`.hyp-metric-context`)

### L2-06: Logs view is unstyled flat text (CRITICAL)
- **Mock**: Claim-clustered logs — 3 clusters (Trigger/Cascade/Absence), signal vs noise distinction, absence evidence with explanatory text
- **Production**: Plain chronological list of identical log entries ("payment dependency rate limited")
- **Missing features**:
  - Claim cluster containers (`.claim-cluster`)
  - Typed cluster headers with color coding
  - Signal highlighting (`.log-row.signal`)
  - Noise dimming (`.log-row.noise`)
  - Absence evidence (`.claim-header` with teal background, explanatory text)
  - Severity badges (`.log-sev.error`, `.log-sev.warn`)

### L2-07: Tab switching doesn't change content
- **Production**: Traces, Metrics, and Logs tabs all render the same unstyled content — tab switching appears non-functional or all three surfaces render identically
- **Impact**: The tab-based evidence exploration is broken

### L2-08: Side rail is missing (CRITICAL)
- **Mock**: Right column (240px) with 3 side notes — Confidence (teal primary), Uncertainty, Affected Dependencies
- **Production**: No side rail rendered. The Evidence Studio is single-column
- **Missing**: Entire `.ev-side` column with `.side-note` cards

### L2-09: Context bar differs
- **Mock**: Compact accent-colored bar — health dot + "INC-0892" + "Stripe rate limit cascade" + "Action: Enable batching + backoff"
- **Production**: Larger card with full incident headline and action paragraphs
- **Impact**: Context bar takes too much vertical space, should be a compact summary

### L2-10: No severity badge in L2 header
- **Mock**: "Evidence Studio ● CRITICAL" with colored severity badge
- **Production**: "Evidence Studio" without severity indicator
- **Code**: `LevelHeader.tsx:79` renders severity badge only if `severity` prop is passed, but `LensShell.tsx:140` doesn't pass severity to L2 header

---

## Design Token Compliance

| Token | CLAUDE.md Value | Mock | Production | Status |
|-------|----------------|------|------------|--------|
| --bg | #FAFAF8 | Correct | Correct | OK |
| --panel | #FFFFFF | Correct | Correct | OK |
| --accent | #E85D3A | Correct | Correct | OK |
| --teal | #0D7377 | Correct | N/A (no QA frame) | Untestable |
| --font | DM Sans | Correct | Correct | OK |
| --mono | JetBrains Mono | Correct | Correct | OK |
| --radius | 6px | Correct | Correct | OK |
| Type scale | 10-20px range | Correct | Correct | OK |

**Typography**: Both use DM Sans for UI text and JetBrains Mono for data/metrics. Token compliance is correct where features exist.

---

## Functional Issues

### F-01: Deep-link / bookmark / refresh breaks L1 and L2
Page reload loses incident context. Only SPA navigation (clicking incident strip) works.

### F-02: Incident ID format inconsistency
- API stores: `inc_8e390cb6-...` (lowercase, underscore)
- Display shows: `INC-8E390CB6-...` (uppercase, dash)
- `parseIncidentId` regex expects: `inc_[A-Za-z0-9_-]+`
- URL shows: `inc_8e390cb6-...` (matches regex, correct)
- Human display should use short form like mock's "INC-0892", not full UUID

### F-03: API 404 on cold start
`GET /api/incidents/:id` returns 404 intermittently — likely the serverless function cold-starts with empty in-memory state and the persistent query may not find incidents created by a different function instance.

### F-04: Tab content doesn't change on Evidence Studio
Switching between Traces/Metrics/Logs shows the same content.

---

## Priority Ranking

### P0 — Blocking (core UX broken)
1. **L2-04**: Traces waterfall rendering — flat text instead of visual waterfall
2. **L2-05**: Metrics hypothesis groups — flat text instead of grouped metrics
3. **L2-06**: Logs claim clusters — flat text instead of clustered logs
4. **L2-07**: Tab switching non-functional
5. **F-01**: Deep-link navigation broken

### P1 — Critical (key features missing)
6. **L2-01**: Proof cards empty (API returns `[]`)
7. **L2-02**: Q&A frame missing (API returns `null`)
8. **L2-08**: Side rail missing
9. **L2-03**: "Diagnosis not available" shown when diagnosis exists
10. **L0-01**: Entry Points tier empty

### P2 — Important (degraded quality)
11. **L0-02**: Stats bar shows 0 Req/s / 0ms P95
12. **L1-06**: Blast radius uses "unknown_service:node"
13. **L0-06**: Incident strip labels generic "validation-web"
14. **L1-02/L1-03**: Headline and action too verbose
15. **L1-07**: Incident ID full UUID in header
16. **L0-03**: No animated edge particles
17. **L0-05**: No node badges or contextual detail

### P3 — Minor (cosmetic)
18. **L0-08**: Zoom nav missing dots
19. **L0-09**: env-tag border styling
20. **L0-04**: Legend position
21. **L2-09**: Context bar too verbose
22. **L2-10**: Missing severity badge in L2 header
