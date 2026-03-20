# Console Design Constraints

Source of truth: `docs/mock/lens-prototype-v1.html`
Status: validated mock, pre-implementation

---

## 1. Product Definition Mapping

| Screen | Role | Primary | Not Primary |
|--------|------|---------|-------------|
| **Normal** | Runtime dependency map | Observed call paths, health per node, anomaly propagation | Architecture diagram, service catalog, dashboard metrics |
| **Incident** | Decision room | Immediate action, blast radius, confidence, operator check, causal chain | Timeline, chat, raw telemetry, generic monitoring |
| **Evidence** | Proof browser | Expected vs observed diff, claim-driven evidence, Q&A | Raw log viewer, generic chart explorer, observability dashboard |

---

## 2. Screen-Level Constraints

### Normal (Runtime Dependency Map)

- Map shows only what recent spans observed. Nothing imagined.
- Nodes are 3 tiers: **Entry Points** (routes/functions) → **Runtime Units** (observable runtime groupings derived from spans — e.g. client classes, handler groups) → **Dependencies** (external services, DBs).
- Runtime Units are not fixed to internal module names. They are whatever grouping the span data supports. If spans only show service-level granularity, that is the unit. Do not invent module names.
- Each tier has distinct visual treatment: shape, border style, position.
- 1-3 nodes must look intentional, not broken. Do not pad with invisible nodes.
- Edges represent observed calls, not architectural intent. Dashed for external.
- Animated dots on edges show traffic flow. Color and speed indicate health.

### Incident (Decision Room)

- First viewport answers: what happened, what to do, how bad is it.
- Reading order: Headline → Action Hero → Blast Radius / Confidence / Operator Check → Root Cause → Causal Chain → Evidence entry.
- Action Hero is the visual dominant element. Largest text, strongest accent.
- Blast Radius shows affected services with error rate bars. Not a mini-map.
- Confidence is a percentage with correlation evidence, not an internal quality score.
- Operator Check is an actionable checklist, not prose.
- Causal Chain is a horizontal flow: External Trigger → Design Gap → Cascade → User Impact.
- No separate Timeline card. Time summary is one line in the Evidence entry.

### Evidence (Proof Browser)

- Structured as: **Question → Answer → Supporting Evidence**.
- Default question is the diagnosis question. User can ask follow-ups.
- Tabs are proof surfaces, not data type selectors.
- Every tab shows **expected vs observed** before raw data.
- **Traces**: Incident trace is primary. Expected trace is collapsed/secondary. Smoking gun span is visually dominant. Span expansion shows attributes + correlated logs.
- **Metrics**: Grouped by hypothesis (trigger / cascade / recovery), not by metric name. Each row shows observed value, expected value, and deviation.
- **Logs**: Clustered by claim (trigger / cascade / absence evidence), not chronological. Signal logs are prominent, noise is dimmed. "Expected but missing" entries are evidence.
- Proof cards at top link to filtered evidence in each tab.
- Side notes show confidence, uncertainty, and affected dependencies.

---

## 3. Experience Flow Constraints

- **Map → Incident → Evidence**: understanding deepens at each level. Never reverses.
- Zoom transitions use scale + blur. Going deeper = zooming in. Going back = zooming out.
- First viewport of each screen must deliver its core value without scrolling.
- **30-second rule**: Map tells you something is wrong. Incident tells you what to do. Evidence tells you why to trust it.
- All view state (zoom level, active tab, expanded panels) must be deep-linkable. URL shape is an implementation decision.
- Escape zooms out. Keyboard navigation works throughout.

---

## 4. Current Scope

- Core evidence: **OTel traces, OTel logs, OTel metrics**. Nothing else.
- Platform logs are out of scope. Do not add a Platform tab. (Note: `product-concept-v0.2.md` still references platform logs — that document needs updating to reflect this constraint. This design constraints doc takes precedence until then.)
- Platform events (deploys, config changes) may exist in the packet but are not a primary evidence surface at launch.
- AI features are embedded in Evidence Studio Q&A, not a separate chat panel.

---

## 5. Implementation Guards

| Do | Do Not |
|----|--------|
| Follow the mock's information hierarchy | Add elements not in the mock |
| Keep Evidence as proof browser with expected/observed | Build a generic observability viewer |
| Use observed spans for the map | Draw architecture diagrams from config |
| Embed AI in Evidence Q&A | Resurrect an independent chat panel |
| Show claim-clustered logs and hypothesis-driven metrics | Show chronological log lists or generic anomaly charts |
| Design for 1-3 map nodes | Require 5+ nodes to look complete |
| Use the vocabulary: expected / observed / deviation | Use: normal / baseline / current inconsistently |

---

## 6. Vocabulary

| Concept | Term | Not |
|---------|------|-----|
| Pre-incident behavior | **expected** | normal, baseline, ok |
| During-incident behavior | **observed** | current, actual, anomalous |
| Difference | **deviation** | delta, change, diff |
| Prediction | **projected** | estimated, predicted |
| Evidence grouping | **claim** | category, type, tab |
| What went wrong | **trigger** | cause, root |
| Design problem | **design gap** | bug, flaw, defect |
| Spread of failure | **cascade** | propagation, chain |
| How to verify fix | **recovery signal** | fix evidence, resolution |
