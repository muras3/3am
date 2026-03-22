# Production Audit Report — 2026-03-22

**Target:** `https://3amoncall.vercel.app` (develop `aa49a7c`, PR #126 merged)
**Reference:** `docs/mock/lens-prototype-v1.html`
**Scenario data:** `third_party_api_rate_limit_cascade` (SpanBuffer 5min TTL — map data volatile)
**Tool:** `browser-use` (headless Chromium)
**Timestamp:** 2026-03-22 02:07 UTC

---

## Level 0 — System Topology Map

| # | Check | Status | Detail |
|---|-------|--------|--------|
| L0-1 | Stats bar 4 blocks | **Pass** | Active Incidents=1, Degraded Nodes, Req/s, P95 |
| L0-1 | Values monospace | **Pass** | JetBrains Mono 28px/800 |
| L0-2 | Runtime Dependency Map renders | **Pass (volatile)** | 5 nodes + edges on initial load. "No traffic observed yet." after 5min TTL expiry (ADR 0029 by design) |
| L0-2 | 3 tier labels | **Partial** | ENTRY POINTS / RUNTIME UNITS / DEPENDENCIES shown vertically. **Entry Points tier has zero nodes** |
| L0-2 | Entry point nodes | **FAIL** | No nodes in entry_point tier. All nodes classified as `runtime_unit`. Route-based classification logic missing (P1-7) |
| L0-2 | Dependency nodes (dashed border) | **Pass** | stripe node with dashed border |
| L0-2 | Critical nodes accent color | **Pass** | accent (#E85D3A) border/glow confirmed |
| L0-3 | Map legend | **Pass** | entry point / runtime unit / dependency / errors / degraded / healthy |
| L0-4 | Active Incidents strip | **Pass** | 1 row: health dot + ID (mono) + name + severity badge + time ago |
| L0-4 | Incident ID format | **P2** | Full UUID `INC-4A512528-265A-4C62-B8C6-17ED8A8FD3A1` — too long, should be short ID |
| L0-4 | Incident name | **P2** | "validation-web" — should use diagnosis headline |
| L0-4 | Click → L1 navigation | **Pass** | Navigates to `?level=1&incidentId=...` (PR #126 fix confirmed) |
| L0-5 | Header: logo + alert dot | **Pass** | "3amoncall" + pulsing dot |
| L0-5 | Environment tag | **Pass** | "production" |
| L0-5 | Clock | **Pass** | UTC display |
| L0-P2 | Stats: Req/s, P95 Latency | **P2** | Always zero (`clusterReqPerSec: 0, clusterP95Ms: 0`) |

---

## Level 1 — Incident Board

| # | Check | Status | Detail |
|---|-------|--------|--------|
| L1-1 | Back button "Map" | **Pass** | Visible, click returns to L0 |
| L1-1 | Incident ID + severity badge | **Pass** | ID + "critical" in header |
| L1-2 | Headline | **Pass** | "validation-web experienced a cascade of checkout and order failures..." |
| L1-2 | Impact chips | **Pass** | 93% (accent-soft), http_429 (amber-soft), stripe (teal-soft) — token colors correct |
| L1-3 | Immediate Action eyebrow | **Pass** | "Immediate Action" label |
| L1-3 | Action text font | **Pass** | 20px / weight 800 / DM Sans |
| L1-3 | Left accent border | **Pass** | rgb(232,93,58) 3px |
| L1-3 | "Why" rationale | **Pass** | Displayed |
| L1-3 | "Do not" warning block | **Pass** | Amber highlight, displayed |
| L1-4 | Blast Radius card | **Pass** | 2 rows: unknown_service:node=93%, validation-web=73% |
| L1-4 | Blast Radius target names | **P2** | "unknown_service:node" — unreadable name |
| L1-4 | Confidence card | **Pass** | 85% "High confidence", risk text present |
| L1-4 | Operator Check card | **Pass** | 7 checklist items with checkbox UI |
| L1-5 | Root Cause Hypothesis | **Pass** | Paragraph text displayed |
| L1-6 | Causal Chain | **Pass** | 5 steps: EXTERNAL TRIGGER → DESIGN GAP ×2 → CASCADE → USER IMPACT |
| L1-6 | Step type border colors | **Pass** | border-top: amber (external), teal (system), ink-3 (incident), accent (impact) |
| L1-6 | Dashed arrow connectors | **Pass** | 4 arrows confirmed |
| L1-7 | Evidence counts | **Pass** | TRACES 3217 (2776 errors), METRICS 299 anomalous, LOGS 2837 (324 errors) |
| L1-7 | Timestamps | **Pass** | Started / Full cascade / Diagnosed — all 3 present |
| L1-7 | "Open Evidence Studio" button | **Pass** | Click navigates to L2 |

---

## Level 2 — Evidence Studio

| # | Check | Status | Detail |
|---|-------|--------|--------|
| L2-1 | Context bar | **Pass** | accent-soft strip, health dot + ID + headline + action summary |
| L2-2 | Proof Cards (3-column grid) | **FAIL** | DOM absent. API `proofCards: []`. `buildCuratedEvidence` not generating proof cards (P1-4) |
| L2-3 | Q&A Frame | **Partial** | Shows "Narrative is being generated. Evidence surfaces are available below." API `qa: null`. Correct fallback message but Q&A functionality not implemented (P1-5) |
| L2-4 | Tab bar (3 tabs) | **CSS BROKEN** | DOM correct (Traces/Metrics/Logs). Tab switching works. **CSS entirely unapplied**: `display: block` (should be `flex`), no padding/gap, no active tab underline. **Root cause: `lens.css:957` `.lens-ev-ctx-headline` missing closing `}`** |
| L2-4 | Tab count badges | **CSS BROKEN** | Rendered as concatenated text "Traces13" instead of separate styled badges |
| L2-5 | Traces: Error header | **CSS BROKEN** | DOM present (route, trace ID, status, duration). Rendered as flat text |
| L2-5 | Traces: Span waterfall bars | **CSS BROKEN** | DOM present (`.lens-traces-bar-track` → `.lens-traces-bar` with `width: 97%` etc). **Track height: 0px** — bars invisible |
| L2-5 | Traces: Smoking-gun highlight | **CSS BROKEN** | Class `smoking-gun` applied but CSS not matching |
| L2-5 | Traces: Expected trace toggle | **Partial** | "Show expected trace" toggle present. Baseline group (muted) in DOM. CSS unapplied |
| L2-5 | Traces: Annotation block | **CSS BROKEN** | DOM present, CSS unapplied |
| L2-6 | Metrics: Hypothesis groups | **CSS BROKEN** | All data present (5 groups, 11 metrics). Rendered as flat text |
| L2-6 | Metrics: Observed/Expected bars | **CSS BROKEN** | Bar DOM present, not visualized |
| L2-7 | Logs: Claim clusters | **Partial** | 3 claim clusters (warn 50, error 50, warn 50) + 4 absence evidence. Log row severity badges (WARN amber, ERROR red) **render correctly**. Cluster header type colors (trigger=accent etc.) CSS unapplied |
| L2-7 | Logs: Absence evidence | **Pass (data)** | 4 clusters: retry/backoff/circuit_breaker, rate_limit/throttle, healthcheck/readiness, fallback/failover — all "0 entries" |
| L2-8 | Side Rail | **FAIL** | DOM absent. API `sideNotes: []` (P1-6) |

---

## Zoom Navigation

| # | Check | Status | Detail |
|---|-------|--------|--------|
| ZN-1 | Bottom floating zoom nav | **Pass** | Map > Incident > Evidence (3 items) |
| ZN-2 | Active level highlight | **Pass** | Current level bold |
| ZN-3 | Click navigation | **Pass** | Each item navigates to correct level |
| ZN-4 | CSS zoom transition | **Weak** | `transition: all` set but scale + opacity + blur animation not confirmed |
| ZN-5 | Escape key → back | **Pass** | L2 → Escape → L1 confirmed |
| ZN-6 | URL updates | **Pass** | `?level=` param correctly updated |

---

## Design Token Compliance

| Token | Expected | Measured | Status |
|-------|----------|----------|--------|
| --bg | #FAFAF8 | rgb(250,250,248) | **Pass** |
| --font | DM Sans | "DM Sans", system-ui | **Pass** |
| --mono | JetBrains Mono | "JetBrains Mono", ui-monospace | **Pass** |
| --accent | #E85D3A | rgb(232,93,58) | **Pass** |
| --teal | #0D7377 | Confirmed (chips, causal chain) | **Pass** |
| --amber | #B8860B | Confirmed (chips, causal chain) | **Pass** |
| --radius | 6px | context-bar 4px (--radius-sm) | **Pass** |

---

## Issue Summary (by priority)

### P0 — Must fix immediately (1 issue)

| # | Issue | Root Cause | Impact |
|---|-------|-----------|--------|
| 1 | Evidence Studio CSS entirely broken | `lens.css:957` — `.lens-ev-ctx-headline` missing closing `}`. All subsequent CSS rules (146 total) are incorrectly nested as descendants of `.lens-ev-ctx-headline` | Tabs, waterfall bars, trace headers, metric bars, annotation blocks, smoking-gun highlights — everything in L2 except context-bar and log severity badges renders as unstyled flat text |

### P1 — Feature gaps (4 issues)

| # | Issue | Detail |
|---|-------|--------|
| 2 | Proof Cards empty | API `proofCards: []`. `buildCuratedEvidence` in receiver not generating proof cards |
| 3 | Q&A null | API `qa: null`. Diagnosis Stage 2 not implemented. Fallback message "Narrative is being generated" displays correctly |
| 4 | Side Notes empty | API `sideNotes: []`. DOM not rendered |
| 5 | Entry Points tier empty | runtime-map API classifies all nodes as `runtime_unit`. Route-based `entry_point` assignment logic not implemented |

### P2 — Quality improvements (4 issues)

| # | Issue | Detail |
|---|-------|--------|
| 6 | Stats bar Req/s and P95 always zero | `clusterReqPerSec: 0, clusterP95Ms: 0` regardless of traffic |
| 7 | Incident name "validation-web" | Should use diagnosis headline for meaningful label |
| 8 | Blast radius "unknown_service:node" | Unreadable auto-generated service name |
| 9 | Incident ID full UUID | `INC-4A512528-265A-4C62-B8C6-17ED8A8FD3A1` — should be shortened |

---

## What's Working Well

- **L0 → L1 → L2 navigation**: All zoom transitions, back button, Escape key, URL params work correctly
- **L1 Incident Board**: Complete and well-styled — headline, action hero, causal chain, context grid, evidence entry all match mock
- **Design tokens**: Background, fonts, accent/teal/amber semantic colors all correct across L0 and L1
- **Diagnosis quality**: Comprehensive output — 85% confidence, 5-step causal chain, 7 operator checks, detailed root cause hypothesis
- **L2 DOM structure**: All Evidence Studio components are correctly built in the DOM. The CSS fix is a 1-character change (`}`) that will unlock the entire L2 visual rendering

---

## Re-audit — 2026-03-22 03:20 UTC

**Deploy:** latest develop (includes CSS fix, entry_point tier logic, stats aggregation, short ID)
**Incident:** `inc_b8ccbdea-9473-4344-a044-42a370e8ea16` (diagnosis state: `unavailable` — not yet triggered)

### Fixed since initial audit

| # | Issue | Status |
|---|-------|--------|
| P0-1 | Evidence Studio CSS broken | **Fixed** — waterfall bars, tabs (flex layout + active underline), metric bars, trace headers, log cluster headers all render correctly |
| P1-5 | Entry Points tier empty | **Fixed** — stripe.charge, checkout.request, orders.request now in ENTRY POINTS tier; payment.charge in RUNTIME UNITS; stripe in DEPENDENCIES |
| P2-6 | Stats Req/s, P95 always zero | **Partially fixed** — values now populated (Req/s, P95 4288ms), but formatting broken (see NEW-1) |
| P2-9 | Incident ID full UUID | **Fixed** — now `INC-B8CCBDEA` (short format) |

### New issues found

| # | Priority | Issue | Detail |
|---|----------|-------|--------|
| NEW-1 | **P1** | Req/s raw float overflow | `1.062777777777778` displayed — 15 decimal places. Should round to 1-2 decimals (e.g. `1.06`) |
| NEW-2 | **P1** | Old incident headline overflows list row | INC-4A512528 row in ACTIVE INCIDENTS strip shows full diagnosis headline text below the row, breaking L0 layout. Headline text should be truncated or not shown in the list |
| NEW-3 | **P2** | Metrics expected values raw float | `expected: 3077.718120805369`, `expected: 0.11409395973154363` — no rounding. Should display 2-3 significant digits |
| NEW-4 | **Info** | Diagnosis not triggered | `state.diagnosis: "unavailable"` — L1 shows empty headline, action, causal chain, root cause, operator checks. Expected if diagnosis hasn't run yet |

### Unchanged issues

| # | Priority | Issue |
|---|----------|-------|
| P1-2 | P1 | Proof Cards empty (`proofCards: []`) |
| P1-3 | P1 | Q&A null (Stage 2 not implemented) |
| P1-4 | P1 | Side Notes empty (`sideNotes: []`) |
| P2-7 | P2 | Incident name "validation-web" (headline not used in list) |
| P2-8 | P2 | Blast radius "unknown_service:node" |

### Overall assessment

The CSS fix was the single highest-impact change — L2 Evidence Studio went from an unstyled text wall to a functional evidence viewer with waterfall bars, metric comparison bars, styled tabs, and log clusters. Entry point tier classification and short IDs also improved L0 significantly. Remaining work is primarily backend (proof cards, Q&A, side notes) and display formatting (float rounding, headline overflow).
