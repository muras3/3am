# Persona B Review — 佐藤さん (UX Design Critic, Vercel Guidelines)
## Overall Assessment: Grade B+ — Solid foundation with a clear hero element, but several hierarchy and compliance issues undermine the stress-state UX promise.

---

## Information Hierarchy

**What works:** The "Immediate Action" section earns its designation as THE HERO. The warm gradient background, 3px left accent border, and 16px bold policy text create a clear focal point. A panicked operator's eye will land here first — that's correct.

**Competing focal points — the dual incident ID problem:** The incident ID `inc_e15e747d` appears twice within a few centimeters of vertical space: once in the topbar and once in the "Incident Header Bar" panel at the top of the center column. This bar (`checkout-service · inc_e15e747d · 18m active · opened 05:06:00 UTC`) is a redundant restatement of the topbar. It consumes ~46px of prime vertical real estate before the user sees any meaningful content. This header-within-a-header pattern creates a false sense of nesting without adding information.

**Scan order mismatch:** The "What Happened" section (the headline + impact chips + bullets) comes *before* the Immediate Action hero section. In a stress state, the operator already knows *something* broke — they need the action first, then the context. The current order forces reading before acting. Bloomberg terminals, trading dashboards, and PagerDuty's critical alert view all surface the action verb before the narrative. This is a cognitive sequencing error.

**The bottom grid competes with itself:** All three bottom cards (Mitigation Watch, Impact & Timeline, Evidence Preview) use identical visual weight — same border, same panel background, same card title styling. But they have different urgency: Mitigation Watch contains live alerting data that should dominate. The equal treatment of "Evidence Preview" (lower urgency, gateway to a deeper tool) alongside "ALERT"-state watch rows creates false equivalence at exactly the point where the operator needs clear priority.

**The right rail "87%" confidence number:** At 28px monospace, this is visually the third-largest element on the screen after the hero headline and the board headline. It competes for attention in a supplementary panel. An operator in crisis should not have the AI's self-assessed confidence rating drawing their eye before they've read the action steps.

---

## Vercel Guidelines Violations

- **"Don't ship the schema" — partial violation:** The raw incident ID `inc_e15e747d` is exposed in the topbar breadcrumb, the incident header bar, AND the Evidence Studio modal title. Three appearances of a raw UUID slug. Users see the internal key, not an accessible label. Per Vercel guidelines, accessible labels should be maintained even when visuals surface raw IDs. The topbar and header bar should display a human-readable label (e.g. "Stripe / Checkout" or "Incident #47") with `inc_e15e747d` available as secondary context, not as the primary identifier repeated three times.

- **`font-variant-numeric: tabular-nums` missing on key elements:** The timer value (`18m`), the topbar timestamp (`05:24:15 UTC`), and several inline metric values in the "What Happened" bullets (`94%`, `212`) do not use the `.timer-val` or `.tl-time` classes which carry `font-variant-numeric: tabular-nums`. The `what-bullet` class uses `var(--ink-2)` text with no tabular-nums. When numbers update live (as they will in the real app), digit widths will shift and cause visual jitter. Any number shown in a comparison or that changes over time must carry tabular-nums.

- **`transition: all` violation (minor):** Not present — but `.incident-item` uses `transition: background 0.15s` which is correct. No violation here.

- **Icon labels missing:** The `pulse-dot` in the topbar logo carries semantic meaning (live/active status) but has no accessible label. The copy button icon-to-text ratio is fine, but the pulsing dot as a status indicator has no `aria-label`. Screen readers will skip it entirely. Per Vercel guidelines, icons convey meaning and must have text for non-sighted users.

- **"Do Not" section uses `✕` as a pseudo-element content string:** This is the `✕` character (U+2715) rendered via `::before { content: '✕'; }`. CSS-generated content is invisible to screen readers. The prohibition items have no accessible negative indicator — a screen reader will hear "Restart the database (unrelated to this incident)" with no negative framing.

- **Active voice violation in "Do Not" items:** "Restart the database (unrelated to this incident)" is ambiguous — it could be read as an instruction *to* restart. The Vercel guideline requires active voice that states the action and consequence clearly. Should read: "Do not restart the database — it is unrelated to this incident and will delay recovery." The current phrasing is passive and parenthetical.

- **Curly quotes not used:** The Operator Check card reads: `Verify STRIPE_CIRCUIT_OPEN is not already set before deploying.` — this is fine prose. But the chat bubble reads: `Circuit breaker deployment is the fastest recovery path. Want me to walk through the Stripe rate limit signals?` — uses straight apostrophe. Vercel guidelines require curly quotes.

- **Empty state in Evidence Studio modal is bare:** The overlay modal shows an empty diamond icon (`◆`), the label "Evidence Studio", and the sub-line "Metrics · Traces · Logs · Platform Logs — full implementation in React app." This violates Vercel's guideline: "Provide next steps or recovery paths on every screen." The sub-line is self-referential implementation commentary, not a recovery path. An operator who accidentally opens the studio during an incident sees a non-actionable placeholder. The empty state should say what to do: "Evidence for this incident is loading." or "No evidence collected yet — check receiver configuration."

- **`transition: all` check on `.btn-evidence`:** The button uses `transition: background 0.15s, transform 0.1s` — correct, no `transition: all`.

- **No `aria-live` region for the chat messages area:** The `#chat-messages` div receives dynamic children via `appendBubble()`. Without `aria-live="polite"`, screen reader users will not hear AI responses. Vercel guidelines require polite `aria-live` for dynamic announcements.

- **The `active-pill` in the topbar duplicates "Active" label:** The topbar already shows `ACTIVE 18m` (the timer group) and then a separate `<div class="active-pill">Active</div>` to the right. The word "Active" appears twice in the top right within ~60px horizontal span. One must go.

---

## Scannability

**5-second scan result:** Partially passes. The headline ("Stripe Rate Limits Cascading into Checkout Failure") and the immediate action block are visible without scrolling on a 1440x900 viewport. Impact chips give quick quantitative context. A panicked operator can identify *what is broken* within 3 seconds.

**Fails on: what to do first.** The Immediate Action hero is below the fold of the "What Happened" section. An operator has to read 4–5 lines of bullets before seeing the action. The section above the action takes ~200px: incident header bar (redundant) + 19px headline + 3 impact chips + 3 bullet lines. All of this pushes the most important element — the action — further down. In stress states, the first visible action verb wins.

**Walls of text:** The "Do Not" section within the action block contains two sentences in `var(--fs-xs)` at `var(--ink-3)` — light grey at 11px. In a high-stress state, low-contrast small text is functionally invisible. These items carry important safety information (don't restart the DB, don't scale replicas) that a stressed operator could miss entirely.

**Chain connector arrows are too subtle:** The dashed animated SVG arrows in the causal chain are 28px wide at 1.5px stroke. They read as decorative, not navigational. The flow direction (External → System → Incident → Impact) is only legible when you're reading carefully, not scanning. Considered on their own, the chain-step boxes feel like peer cards, not a sequential narrative.

**The "grounded" badge on the right rail:** This is 9px text in teal on a teal background. At a glance it looks like a tag/chip for status, but "grounded" is unexplained jargon. A user in crisis does not have cognitive budget to decode what "grounded" means for their AI copilot confidence. Tooltip or inline explanation required.

---

## Layout & Spacing

**Left rail (180px): appropriate density, one issue.** The resolved "image-resize" item uses `opacity: 0.5` inline style — a hardcoded value outside the token system. Resolved items should use a semantic state (e.g. a `.resolved` class) rather than an ad-hoc opacity hack. Also, the rail footer ("Open now: 2 incidents / Last 24h: 3 total") is useful but sits visually disconnected from the list above — it's only separated by `margin-top: auto`, which on small viewports or when there are many incidents could overlap the list.

**Center column:** The `padding: 20px 28px` gives 28px of horizontal breathing room — correct for the 3-column layout. However, the `gap: 18px` between sections is too uniform. The "What Happened" → "Immediate Action" gap should be tighter (12px) to reinforce that they are read together, while the "Immediate Action" → "Why This Action" gap should be wider (24px) to create a cognitive break between act-now content and explanatory content.

**Right rail (220px): overcrowded above the fold.** The copilot header — title, grounded badge, 28px confidence number, label, signal count, and the 3px progress bar — all stack in ~90px of height before the cards appear. The confidence number at 28px is the largest font on the entire right rail. This creates a visual spike in the supplementary panel that competes with the center board's hero. The confidence number should be reduced to 20px (matching `--fs-xl`) and the bar should be the primary communication of confidence level, not the raw percentage.

**Bottom grid spacing:** The 3-column `1fr 1fr 1fr` grid is geometrically balanced but not semantically balanced. Mitigation Watch (live alerting data with 3 ALERT status badges) shares equal visual weight with Evidence Preview (a link to a deeper tool). The grid should weight Mitigation Watch at `1.2fr` or visually differentiate it with a subtle accent border to signal "this is the live monitoring panel."

**Chain connector SVGs lack vertical centering:** In the screenshot, the dashed arrows appear vertically centered within their `chain-step` cards but the SVG `viewBox="0 0 28 12"` is only 12px tall. Combined with `align-items: stretch` on the `.chain-flow`, the connectors risk mis-aligning with card content on different content lengths. The chain-step cards use `flex: 1` which will equalize heights, but the connector alignment is fragile if card content varies.

---

## Typography & Token Compliance

**Compliant elements:**
- `DM Sans` used correctly for all prose/label text
- `JetBrains Mono` used correctly for IDs, timestamps, code, and metric values
- Design token CSS variables used consistently throughout — no raw hex values leak into the component styles (the `#E8E8E5` and `#F6A04A` in `.operate-cmd` are the only exceptions, see below)

**Violations:**

- **Hardcoded `#E8E8E5` and `#F6A04A`** in `.operate-cmd` and `.var-hi`: These are undeclared colors not in the design token system. `#E8E8E5` is a near-white used for the command text on the dark terminal background — it should be `rgba(255,255,255,0.85)` or added as a named token (e.g. `--terminal-text`). `#F6A04A` is a warm orange used for the variable highlight — not a token. This should be `var(--amber)` or a new declared token.

- **`font-size: 9px` used in six places**: `.sev-badge`, `.step-tag`, `.watch-status`, `.grounded-badge`, `.cc-label`, `.ask-label`. This is below the project's defined `--fs-xxs: 10px` minimum. 9px text violates the token system's own type scale floor. On a retina display it reads fine but on standard DPI or at any browser text scale setting it becomes illegible. All 9px instances should be raised to `var(--fs-xxs)` (10px).

- **`board-headline` uses `font-size: 19px`** — not a token value. The scale defines `--fs-xl: 20px`. This 1px deviation is either an intentional optical refinement (acceptable if documented) or an accidental off-token value. Given the scale gap between `--fs-lg: 16px` and `--fs-xl: 20px`, 19px is neither. Use `--fs-xl` or define a named step.

- **`confidence-num` uses `font-size: 28px`** — no token. Same issue as above. The type scale does not include 28px. This is a display-size number that needs a token: `--fs-display: 28px` or it should be reduced to `--fs-xl` (20px).

- **`modal-title` uses `font-size: 15px`** — not a token. Between `--fs-md: 13px` and `--fs-lg: 16px`. Should use `--fs-lg`.

- **`tabular-nums` not applied to inline percentage values** in `.what-bullet`: "94%" appears as unstyled prose text within a bullet, not in a mono class. When live-updating, this will jitter.

---

## Top 3 Priority Fixes

**1. Invert the section order: Immediate Action before What Happened.**
The single highest-impact change. Move the hero action block to position 2 (immediately below the incident header bar), and move "What Happened" to position 3. This aligns the cognitive scan order with operator urgency. The action block is already styled as THE HERO — let it act like one by appearing first. In every high-stakes ops console design (PagerDuty, Grafana Incident, Datadog Incidents), the recommended action is above the situational narrative.

**2. Eliminate the redundant Incident Header Bar.**
The bar at the top of the center board (`inc_e15e747d · checkout-service · 18m active · opened 05:06:00 UTC`) restates everything already in the topbar. It costs ~46px of vertical real estate that should belong to the action hero. Remove it entirely, or collapse it into a 1-line status strip that only adds information not in the topbar (e.g. formation window timestamps). This change, combined with fix #1, will bring the Immediate Action section fully above the fold without scrolling.

**3. Fix the 9px type violations and off-token font sizes.**
Six components use `font-size: 9px` which is below the declared `--fs-xxs: 10px` floor. Additionally, `board-headline` (19px), `confidence-num` (28px), and `modal-title` (15px) are off-scale. Add `--fs-display: 28px` to the token set if a display size is needed, and normalize everything else to the nearest defined token step. This is a token compliance discipline issue that will compound as the component library grows.

---

## What Works Well

**The hero section design is genuinely strong.** The gradient background with accent border, the Policy / Operate / Steps layering, the dark terminal box for the command, and the numbered step badges are all well-executed. This section would not look out of place in a Vercel dashboard or Linear's incident view. The decision to separate "Do Not" at the bottom with a faint divider is architecturally correct.

**Token adoption is high.** The vast majority of the UI uses CSS variables correctly. The color palette is disciplined — the warm red accent (`--accent`) appears exactly where it should (alerts, CTAs, critical states) and nowhere else. The amber/teal/good semantic color system is applied consistently across chips, badges, and status indicators.

**The causal chain concept is the right UX pattern.** Even if the execution needs visual refinement, the External → System → Incident → Impact four-step model gives operators a fast mental model for root cause vs. symptom. This is a differentiating feature compared to generic alert tools that just show raw metrics. The animated dashed connectors, while too subtle, are the right gesture.

**The right rail AI Copilot structure is appropriate.** Confidence score, Uncertainty card, Operator Check card, pre-seeded chat with canned follow-up questions — this is a well-structured progressive disclosure of AI support. The "Ask About" chip pattern reduces the blank-input anxiety that most chat interfaces create.

**Font selection and rendering:** DM Sans + JetBrains Mono is an excellent editorial-utilitarian pairing. The `-webkit-font-smoothing: antialiased` is applied correctly. The monospace usage for IDs, timestamps, and code snippets is disciplined and consistent.
