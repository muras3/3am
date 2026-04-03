# E2E Browser Test Checklist

Target: `https://3am-production.up.railway.app`
Auth: Bearer token from `.env.staging`
Tool: `agent-browser`

## Pre-conditions

1. Run scenario against Railway staging:
   ```bash
   cd validation
   make up
   make run SCENARIO=third_party_api_rate_limit_cascade
   ```
2. Wait ~3 minutes for diagnosis to complete (DIAGNOSIS_MAX_WAIT_MS=180000)
3. Verify API readiness:
   ```bash
   curl -s -H "Authorization: Bearer $RECEIVER_AUTH_TOKEN" \
     https://3am-production.up.railway.app/api/runtime-map | jq '.summary'
   curl -s -H "Authorization: Bearer $RECEIVER_AUTH_TOKEN" \
     https://3am-production.up.railway.app/api/incidents | jq '.[0].incidentId'
   ```
   - runtime-map summary should have non-zero values
   - At least 1 incident should exist

---

## Level 0 — System Topology Map (`/?level=0`)

Source: lens-prototype-v1.html L0, console-data-requirements.md §1 Normal

### L0-1: Stats bar
- [ ] 4 stat blocks visible: Active Incidents, Degraded Nodes, Req/s (cluster), P95 Latency
- [ ] At least "Active Incidents" > 0
- [ ] Values use monospace font (JetBrains Mono / --mono)

### L0-2: Runtime Dependency Map
- [ ] SVG map renders with nodes
- [ ] 3 tier labels visible: "Entry Points", "Runtime Units", "Dependencies"
- [ ] Tier divider lines present
- [ ] At least 1 entry_point node (e.g. route like POST /checkout or similar)
- [ ] At least 1 dependency node (external, dashed border style)
- [ ] Edges connect nodes (SVG paths visible)
- [ ] Critical nodes show accent color (#E85D3A) border/glow
- [ ] Healthy nodes show green (#2E7D52) indicator

### L0-3: Map legend
- [ ] Legend row visible below map: entry point, runtime unit, dependency, errors, degraded, healthy

### L0-4: Active Incidents strip
- [ ] At least 1 incident row
- [ ] Incident row shows: health dot, incident ID (mono), name, severity badge, time ago
- [ ] Clicking incident row navigates to Level 1

### L0-5: Header
- [ ] Logo "3am" with alert dot (pulsing if incidents exist)
- [ ] Environment tag (e.g. "production")
- [ ] Clock display

---

## Level 1 — Incident Board (`/?level=1&incidentId=<id>`)

Source: lens-prototype-v1.html L1, console-data-requirements.md §1 Incident

### L1-1: Navigation
- [ ] Back button "Map" visible in header
- [ ] Clicking back returns to Level 0
- [ ] Incident ID and severity badge in header
- [ ] Duration displayed

### L1-2: What Happened
- [ ] Incident ID (mono font)
- [ ] Severity badge (critical = accent color)
- [ ] Headline text (h1, bold)
- [ ] Impact chips present (critical/external/system variants with correct colors)

### L1-3: Immediate Action (hero block)
- [ ] "Immediate Action" eyebrow label with star icon
- [ ] Action text in large bold font (--fs-xl, 20px)
- [ ] Left accent border (#E85D3A)
- [ ] "Why" rationale text below action
- [ ] "Do not" warning block (amber highlight) — may be empty if diagnosis doesn't produce one

### L1-4: Context Grid (3-column)

#### Blast Radius
- [ ] Card titled "Blast Radius"
- [ ] At least 1 service row with: health dot, service name, bar chart, percentage
- [ ] Critical service shows accent color bar
- [ ] Healthy rollup row (e.g. "N other services ok")

#### Confidence
- [ ] Card titled "Confidence"
- [ ] Percentage value displayed
- [ ] Label text (e.g. "High confidence")
- [ ] Basis text explaining correlation
- [ ] Risk text (amber) if present

#### Operator Check
- [ ] Card titled "Operator Check"
- [ ] Checklist items with checkbox UI
- [ ] At least 1 check item

### L1-5: Root Cause Hypothesis
- [ ] Section label "Root Cause Hypothesis"
- [ ] Text paragraph explaining root cause

### L1-6: Causal Chain
- [ ] Section label "Causal Chain"
- [ ] Horizontal flow of chain steps
- [ ] Each step has: type tag, title, detail
- [ ] Step types use correct left-border colors:
  - external = amber (#B8860B)
  - system = teal (#0D7377)
  - incident = ink-3
  - impact = accent (#E85D3A)
- [ ] Dashed arrow connectors between steps

### L1-7: Evidence Entry
- [ ] Evidence counts: Traces (with error count), Metrics, Logs (with error count)
- [ ] Timestamps: startedAt, fullCascadeAt, diagnosedAt
- [ ] "Open Evidence Studio" button
- [ ] Clicking button navigates to Level 2

---

## Level 2 — Evidence Studio (`/?level=2&incidentId=<id>`)

Source: lens-prototype-v1.html L2, console-data-requirements.md §1 Evidence

### L2-1: Context bar
- [ ] Accent-soft strip at top
- [ ] Health dot + incident ID + headline + action summary

### L2-2: Proof Cards
- [ ] 3-column grid of proof cards
- [ ] Each card has: icon, label, status badge (Confirmed/Inferred), summary text
- [ ] Card types: trigger (accent), design_gap (amber), recovery (green)
- [ ] Clicking a card highlights related evidence below
- [ ] If diagnosis/proof data is pending, 3 placeholder proof boxes still remain visible with `Pending` badges

### L2-3: Q&A Frame
- [ ] Question row with "?" icon
- [ ] Answer block (teal background) with grounded answer text
- [ ] Evidence note showing counts (e.g. "12 traces, 3 metrics, 28 logs")
- [ ] Follow-up question chips below answer
- [ ] If QA is unavailable, the Q&A frame still renders a placeholder answer block instead of disappearing

### L2-4: Evidence Tabs
- [ ] 3 tabs: Traces, Metrics, Logs
- [ ] Active tab has underline indicator
- [ ] Tab switching works (click each tab)
- [ ] Zero-count tabs still render `0` badges rather than hiding counts

### L2-5: Traces tab
- [ ] Observed trace group with:
  - Error header (accent background, route, trace ID, status, duration vs expected)
  - Span waterfall rows with bar visualization
  - Smoking-gun span highlighted (accent left border, bold)
  - Expandable span detail (attributes + correlated logs)
- [ ] "Show expected trace" toggle (collapsed by default)
- [ ] Expected trace group (muted/dashed style) shows baseline comparison
- [ ] Annotation block explaining deviation ("Observed vs Expected")
- [ ] Span click expands detail, and proof/QA link navigation scrolls to the targeted span
- [ ] If no baseline exists, traces still keep the expected-trace box/toggle with disabled sparse/unavailable copy

### L2-6: Metrics tab
- [ ] Hypothesis groups with:
  - Typed header (trigger=accent, cascade=amber, recovery=green)
  - Claim text + verdict badge (Confirmed/Inferred)
  - Metric rows: name, observed value, bar, expected value context
- [ ] At least trigger + cascade groups present
- [ ] If metrics are sparse/empty, the metrics panel still renders as a reserved box with fallback copy

### L2-7: Logs tab
- [ ] Claim clusters with:
  - Typed header matching hypothesis type
  - Log entry rows: timestamp (mono), severity badge, body text
  - Signal rows have accent left border
  - Noise rows are dimmed (opacity)
- [ ] Absence evidence cluster:
  - Teal header with "Absence evidence" label
  - "0 entries" count
  - Italic explanation text (expected vs observed)
- [ ] If logs are sparse/empty, the logs panel still renders as a reserved box with fallback copy

### L2-8: Side Rail
- [ ] Right sidebar (240px) with side note cards
- [ ] Confidence note (teal border variant)
- [ ] Uncertainty note
- [ ] Affected Dependencies note
- [ ] If narrative side notes are absent, placeholder side-note cards still remain visible

---

## Zoom Navigation

- [ ] Bottom floating zoom nav bar visible
- [ ] 3 items: Map > Incident > Evidence
- [ ] Active level is highlighted
- [ ] Clicking items navigates to correct level
- [ ] CSS zoom transition (scale + opacity + blur) animates on level change
- [ ] Escape key goes back one level
- [ ] URL updates with ?level= param on navigation

---

## Design Token Compliance

Spot-check across all levels:
- [ ] Background is #FAFAF8 (--bg)
- [ ] Primary font is DM Sans (--font)
- [ ] Data/metrics use JetBrains Mono (--mono)
- [ ] Accent color is #E85D3A
- [ ] Teal is #0D7377
- [ ] Amber is #B8860B
- [ ] No colors outside the token set
- [ ] Border radius ~6px (--radius)
- [ ] Information-dense layout (compact rows, not excessive whitespace)

---

## Empty/Degraded States (if testable)

- [ ] Before diagnosis completes: Level 1 shows "pending" state
- [ ] Before diagnosis completes: Level 2 still shows Context bar, Proof Cards, Q&A, Tabs, Traces, Metrics, Logs, and Side Rail boxes
- [ ] If no baseline data: traces show disabled expected-trace copy and keep the baseline container visible
- [ ] If evidence is sparse: Metrics / Logs / Side Rail use fallback copy but do not disappear
- [ ] If no incidents: Level 0 shows empty incident strip gracefully
