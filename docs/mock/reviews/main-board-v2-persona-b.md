# Persona B Review — 佐藤さん (UX Design Critic, Vercel Guidelines)
## v2 Round 2 Review

## Overall Assessment: Grade A− — A genuinely strong improvement. The act-first architecture now works. Remaining issues are real but targeted; none break the core UX promise.

The three issues I flagged as Top 3 in v1 have all been addressed:

1. **Immediate Action is now first** — fixed. This single change transforms the feel of the product. An operator landing on this screen during an incident sees the action before anything else.
2. **Redundant incident header bar removed** — fixed. The topbar carries the contextual weight. The center column opens directly into the action block.
3. **9px type violations resolved** — all six instances raised to `var(--fs-xxs)` (10px). The 28px `confidence-num` reduced to `var(--fs-xl)` (20px). The 19px `board-headline` now uses `var(--fs-xl)`. The 15px `modal-title` now uses `var(--fs-lg)`.

The token compliance cleanup is thorough: `#E8E8E5` replaced with `rgba(255,255,255,0.85)`, `#F6A04A` replaced with `var(--amber)`. The duplicate "Active" label in the topbar is gone — merged into a single `active-timer` pill. The `aria-live="polite"` is on `#chat-messages`. The `✕` is now HTML content with `aria-hidden="true"` (no longer CSS `::before`).

These were not cosmetic fixes. v1 → v2 represents a disciplined, complete response to structural feedback.

---

## 1. Information Flow Validation — Does "Action First" Work?

**Yes, but with one structural tension that will bite non-expert users.**

The act-first ordering is correct by product logic (product-definition-v0 Section 5: "最上部で優先されるのは今すぐ取るべきアクション"). An operator who lands mid-incident, reads the preflight warning, sees "Shed non-critical Stripe calls immediately," sees the env-var command, and gets the 3 steps — that is a 30-second runbook. This is the right shape.

**The structural tension:** the Immediate Action section is ~420px tall on a 1440×900 viewport. "What Happened" — the headline and context — starts below the fold. This means an operator reads the *prescription* before they read the *diagnosis*. For an expert operator who trusts the AI, this is fine. For the target user (product-definition-v0 Section 2: "observability専門家ではない") this creates a subtle credibility gap: "I'm being told to set an env var and redeploy — but I haven't yet seen *what is broken*."

The Preflight warning at the top of the action section partially addresses this — it tells the operator to verify before acting. But the incident headline ("Stripe Rate Limits Cascading into Checkout Failure") is hidden below the fold. The operator may not scroll there; they may just execute.

This is a trade-off, not an error. The product-definition explicitly says "安全な初動を1つだけ強く提示すること" — and that is achieved. But the section could be tightened: the Policy layer text ("Shed non-critical Stripe calls immediately to protect checkout path") already implicitly names the cause. Trimming the action section height by 40–60px (compressing the Steps or the Do Not section) would bring the "What Happened" headline into view without scrolling. That would close the credibility gap without reverting the section order.

---

## 2. Product Definition Alignment

### Section 4 — "AI の役割": Proposal + Explicit Limitations

**Partial pass.** The confidence number (87%), uncertainty card, and competing hypothesis card address "明示的な限界." The grounded badge + tooltip addresses "grounded in telemetry." These are the right signals.

**What's still weak:** The right rail presents the AI's limitations as supplementary cards that a stressed operator may never read. Per product-definition-v0: "信頼形成に必要な順序は: 不確実性の明示 → 短く明快な根拠 → evidence → chat." The uncertainty should appear *before* confidence, not after. Currently the layout is: Confidence 87% → Uncertainty → Competing Hypothesis. The operator reads confidence first, which creates an unearned trust anchor before they see the limitation. The card order should be inverted: Uncertainty → Competing Hypothesis → Confidence.

### Section 7 — "recovery の考え方": Mitigation Watch as 復旧の見取り図

**Mostly passes, one gap.**

The Mitigation Watch card now has the 2px top accent border signaling "live," and the trend indicators (↓ still falling, → stable, ↑ worsening) give directional context without requiring metric literacy. The action item → watch row connection is made explicit in Step 3: "Verify order success rate recovers in Mitigation Watch below." This is the intended 復旧の見取り図 pattern.

**The gap:** the watch rows show raw metric names ("Order success rate," "Stripe 429 rate," "Checkout latency p95"). Per product-definition-v0 Section 7, watch items should be structured as: 1. 行動ベース 2. 意味ベース 3. 指標名ベース. Currently the labels are pure 指標名ベース. "Order success rate" is a metric name, not a recovery signal. It should read closer to "Checkout recovering?" with the metric name as secondary. This is a labeling issue, not a layout issue — and it matters because the target user does not have observability fluency.

### Section 8 — "AI chat の役割": Deepening, Not Navigating

**Passes well.** The pre-seeded bubble ("Circuit breaker deployment is the fastest recovery path. Want me to walk through the Stripe rate limit signals?") frames the chat as a validation layer, not a help panel. The three Ask About chips ("Could this still be deploy-related?", "What tells us the action worked?", "What competing hypothesis remains?") are all *validation-of-proposal* questions, not navigation prompts. This directly aligns with product-definition-v0 Section 8: "提案の妥当性を詰めること."

**One issue:** the chat bubble text uses a straight apostrophe: `Circuit breaker deployment is the fastest recovery path. Want me to walk through the Stripe rate limit signals?` — "me" is fine, but "don't" if it appeared would need a curly quote. The current text is clean. However the canned responses in the JS include: `'Unlikely — the error pattern starts with Stripe 429s, not an internal restart.'` — these are static strings in JS (not visible as HTML) so they will render as straight quotes in the UI. When these appear as chat bubbles, they will violate the Vercel curly-quote guideline. This is minor but present.

---

## 3. Why This Action (Causal Chain) — Cognitive Load Assessment

**For the non-expert target user, this section is currently a liability.**

The four-step chain (External → System → Incident → Impact) with amber/teal/accent/accent left-borders is visually correct and the semantic color coding is applied consistently. For an expert operator, it's efficient.

For the target user — per product-definition-v0 Section 2, "raw telemetry の読解力を前提にしてはいけない" — the problem is twofold:

**First:** The labels "External," "System," "Incident," "Impact" are taxonomy terms, not operator language. An operator in crisis does not think in terms of "External → System → Incident → Impact." They think "Stripe is broken → checkout is down → orders are failing → customers are angry." The labels should be de-jargonized: "3rd Party," "Our Service," "What Failed," "Who's Affected" — or even simpler, drop the category labels entirely and use sequential connectors with plain-language card titles.

**Second:** The chain currently repeats information already shown elsewhere. "Stripe API → HTTP 429 / Rate limited since 05:06 UTC · 847/min" reappears from the What Happened bullets. "94% order failure rate / 212 span errors · −96 req/s throughput" also appears in the impact chips. The chain has almost zero new information for an operator who has read the rest of the board. Its value proposition is the *causality link* between nodes — but that logic ("no circuit breaker means requests flood Stripe") is expressed only in the "System" card's detail text in 11px ink-3, which is the least readable text on the chain.

**Recommendation for v3:** Either (a) collapse the chain to 2–3 steps and lead each card with the causal verb ("Because Stripe rate-limited us → checkout has no circuit breaker → all orders fail"), or (b) consider whether this section is doing work the product-definition actually requires. The product-definition Section 1 requires "なぜその提案なのか" — the causal chain answers this, but it is currently answering it redundantly and in jargon. A single bold sentence above the chain ("Why this action: Stripe is throttling us, and checkout has no protection against it") may serve the non-expert user better than the four-card visualization.

---

## 4. Remaining Vercel Guideline Violations

### Font size violations — partially resolved

**Remaining violation:** `.topbar-logo` uses `font-size: 14px` — not a token. The type scale is `--fs-sm: 12px / --fs-md: 13px / --fs-lg: 16px`. 14px sits between `--fs-md` and `--fs-lg`. This is a single instance; use `--fs-md` or `--fs-lg`.

**Remaining violation:** `.modal-empty-icon` uses `font-size: 2rem` — not a token. This is an emoji/icon used decoratively (opacity: 0.2), so the absolute size matters less, but it still violates the token system. Use `var(--fs-xl)` or define `--fs-display`.

### Off-token colors — one remaining

**Resolved:** `#E8E8E5` and `#F6A04A` are gone. Good.

**Remaining:** In `.operate-cmd`, the color is now `rgba(255,255,255,0.85)` — this is technically valid (not a named hex off-token), but it is an undeclared semantic concept ("terminal text on dark background"). If this reappears in the React implementation, it will be a magic value. A named token `--terminal-text: rgba(255,255,255,0.85)` would be correct. Not a blocking issue for a mock.

### "Do Not" accessibility — partially resolved

The `✕` moved from CSS `::before` content to HTML span with `aria-hidden="true"`. This fixes the screen reader invisibility issue. The `do-not-section` has `aria-label="Do not do these things"`.

**Remaining gap:** The individual `do-not-item` elements have no role or label. A screen reader traversing the list reads each item as plain text: "Do not restart the database — it is unrelated to this incident and will delay recovery." This is actually fine — the text is now self-describing with active-voice full sentences (v1's passive parenthetical phrasing was fixed). The `aria-hidden="true"` on the ✕ span is correct. **This is resolved.**

### Schema labels exposed

**Still present:** The Evidence Studio modal title reads `inc_e15e747d · checkout-service`. The raw UUID slug is the primary label in the modal header. Per Vercel guidelines "don't ship the schema" — the accessible label should be "checkout-service · Stripe Rate Limits" or similar. The UUID can remain as secondary context (`inc_e15e747d` in a mono style below the title). The modal header `.modal-eyebrow` says "Evidence Studio" which is the correct primary label, but the `.modal-title` being the raw ID is still a violation.

**Also present in topbar:** `inc_e15e747d` appears as the primary contextual label in `.topbar-incident .inc-id` before "checkout-service." The order is ID → service name. Per product-definition-v0 and Vercel guidelines, human-readable context should precede raw identifiers. The topbar should read "checkout-service · inc_e15e747d" not the reverse.

### `aria-live` on chat — fixed

`aria-live="polite"` is on `#chat-messages`. This was a v1 blocker; it is resolved.

### Curly quotes

The HTML static content appears clean. The JS canned response strings will render as straight quotes in the chat UI. Minor, but present.

---

## 5. Density and Scroll

The center column now requires approximately 1.4× scroll on a 1440×900 viewport. The section order is:

1. Immediate Action (~420px)
2. What Happened (~160px)
3. Why This Action / Causal Chain (~140px)
4. Bottom 2-col Grid (~220px+)

Total: ~940px of content with 18px gaps × 3 = ~1000px on a 900px visible area. Roughly one scroll depth.

**The causal chain is the primary culprit for excess scroll.** It adds ~140px that, as argued in Section 3 above, is of questionable value for the non-expert target user. Removing it or collapsing it to a 2-line inline summary would bring the bottom grid closer to the fold and give Mitigation Watch more screen time — which is exactly the "復旧の見取り図" it should be.

**The Do Not section** adds ~80px to the Immediate Action block. These are two important safety items. But they are the last thing in a 420px block that an operator under pressure may not scroll to. Consider relocating "Do Not" to the right rail (as a third card below Competing Hypothesis) or to a collapsed disclosure by default. This would reduce the hero block height by ~80px.

---

## 6. Right Rail — 220px Width Assessment

**220px is tight for the Competing Hypothesis text.** The card reads: "Account-level Stripe throttling vs. shared rate limit pool. Check your Stripe dashboard for quota warnings."

At 11px (`--fs-xs`) with `--fs-md` line-height (1.35), this fits in ~3 lines within a 10px-padded card at 220px. It is legible but dense. The teal "grounded" badge tooltip ("Analysis grounded in telemetry signals from this incident") is 11 words at 10px (`--fs-xxs`). This is at the lower edge of comfortable reading.

**The 87% confidence number is now at `--fs-xl` (20px)** — correct. The competition with the center board's hero is resolved. The bar is now the primary confidence communicator, with the number as secondary reinforcement. This was a specific v1 complaint; it is cleanly fixed.

**The "Uncertainty" and "Competing Hypothesis" cards** sit above the chat bubble. At 220px, the cards feel cramped but functional. The card label text ("UNCERTAINTY," "COMPETING HYPOTHESIS") at 10px uppercase with 0.06em tracking is at the minimum legible threshold. Bumping to `--fs-xs` (11px) would improve readability without materially affecting density.

---

## Top 3 Priorities for v3

**1. [Blocking] Invert the right rail card order: Uncertainty before Confidence.**

Per product-definition-v0 Section 4, trust is built in order: "不確実性の明示 → 短く明快な根拠 → evidence → chat." Showing "87% CONFIDENCE" before "Cannot confirm whether Stripe acknowledged the issue" sets up unearned certainty. The operator should meet the limitation before the assertion. Card order in v3: Uncertainty → Competing Hypothesis → Confidence bar (small, below the uncertainty cards). This is a 3-line DOM reorder but carries semantic weight — it is the correct UI posture for "AI proposal + explicit limitations."

**2. [Blocking] Relabel Mitigation Watch rows in action-first language.**

"Order success rate," "Stripe 429 rate," "Checkout latency p95" are metric names, not recovery signals. Per product-definition-v0 Section 7, the structure should be 行動ベース first. Example rewrites: "Orders recovering?" / "Stripe throttle lifting?" / "Response times normalizing?" with the metric name as a secondary subtitle. This is a copy change only and directly addresses the product-definition principle that "raw metrics の自己解釈を要求するべきではない."

**3. [Blocking] Move the Evidence Studio modal title from raw ID to human-readable label.**

`.modal-title` currently shows `inc_e15e747d · checkout-service`. Per Vercel guidelines, the accessible label should lead with human context. Change to: primary = "checkout-service — Stripe Rate Limits", secondary (mono, ink-3) = `inc_e15e747d`. The UUID should not be the first thing a user reads when the Evidence Studio opens. Same fix applies to the topbar `.inc-id` placement — ID should follow, not precede, the service name.

---

## Nice-to-Have for v3 (Non-Blocking)

- **Causal chain: reduce or simplify.** Either drop to 2 steps, rewrite labels in operator language, or replace with a 2-line inline sentence. The 4-card visual is well-executed but redundant for the non-expert target user.
- **Do Not section: consider right rail or collapsed disclosure.** Frees ~80px from the hero block, keeping the most urgent content visible above the fold.
- **`topbar-logo` font-size: 14px** → use `--fs-md` or `--fs-lg` to resolve the single remaining token deviation.
- **Canned response strings in JS** → use curly quotes (U+2018/2019 U+201C/201D) for apostrophes in chat responses.
- **Watch row card labels** uppercase tracking at `--fs-xs` (11px) instead of `--fs-xxs` (10px) for improved readability at 220px width.

---

## What Works Well (Confirmed from v1, Strengthened in v2)

**The act-first architecture is now real.** Immediate Action above the fold, hero styling intact, preflight warning in context, 3 steps clear. An operator who lands on this screen during a live incident has everything they need within the visible viewport. This is the product-definition fulfilled in UI.

**Token compliance is now essentially clean.** The only remaining deviations are minor (14px logo, 2rem icon) and one undeclared semantic value (`rgba(255,255,255,0.85)`). The color palette discipline is excellent — the warm red accent appears only where urgency demands it.

**The Do Not section is qualitatively better.** Active-voice full sentences with explicit reasoning ("it is unrelated to this incident and will delay recovery") replaced the passive parenthetical phrasing of v1. An operator under stress can read and act on this.

**The merged `active-timer` pill** eliminates the dual "Active" repetition. Clean.

**Mitigation Watch with trend indicators** is a meaningful improvement. The directional arrows (↓ still falling, → stable at bad level, ↑ worsening latency) give the operator a trajectory read without requiring them to interpret time-series data. The 2px top accent border differentiating the watch card from Evidence Preview resolves the false-equivalence complaint from v1.

**The grounded badge tooltip** ("Analysis grounded in telemetry signals from this incident") finally explains the "grounded" jargon. The implementation is correct (tabindex, role=tooltip, aria-describedby). The v1 complaint about unexplained terminology is resolved.
