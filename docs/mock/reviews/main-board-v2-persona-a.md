# Persona A Review — 田中さん (Solo Dev, 3am Incident) — v2

**Reviewer persona**: Solo developer, woken at 3:14 AM by Stripe alerts. Laptop just opened. Heart racing. Goal: understand what is broken and what to do in 30 seconds.

**Round 2 focus**: What is still broken or introduces new problems. Items already fixed in v2 are not repeated.

## Verdict: Action is now first, but the page has a sequencing problem that creates confusion before clarity

The move to put Immediate Action at the top was the right call. Eyes land on the action box immediately and I can copy the command in under 10 seconds. That part works.

But the current order — Action → Headline → Why — creates a new problem: I am being asked to act before I know what I am acting on. The Preflight warning makes this worse, not better. It injects a stop-and-check moment at exactly the wrong place: before I have even read the headline.

---

## First 5 seconds (what changed from v1)

In v1, eyes went to the headline first. In v2, they go to the amber Preflight bar at the very top. The ⚠ icon and amber background are the highest-contrast element on load. My first thought is "something is wrong with the tool" — not "this is a safety check for what I'm about to do." The warning fires before I know what I am even being warned about.

After the Preflight bar, my eyes drop to POLICY ("Shed non-critical Stripe calls...") and then the command. Then — only then — do I scroll down to see the headline "Stripe Rate Limits Cascading into Checkout Failure."

The sequence I actually experience:

1. Warning (about what?)
2. Policy sentence (for what action?)
3. Command (for which problem?)
4. Headline (oh, *that* is what this is about)

This is inverted. The action box works as an anchor only once you understand context. Without context, the action box is an instruction from a stranger.

---

## Critical Issues (new or remaining)

**1. Preflight warning fires before the headline — causes momentary panic before comprehension**

The amber "Preflight: Verify STRIPE_CIRCUIT_OPEN is not already set before deploying" bar sits above POLICY and above any incident description. At 3am, groggy, I read this and my first reaction is confusion about *why* I need to check that — because I have not yet read what is happening. I will click Copy first, then remember I was supposed to check something, then not know where to check it.

The warning is good content. It is in the wrong position. It belongs *below* the command, as a final-step confirmation, not as the first thing I read inside the action box. Alternatively: move it to step 0 of the numbered list ("Before step 1: Verify STRIPE_CIRCUIT_OPEN is not already set").

**2. Competing Hypothesis in the right rail creates active doubt at the worst moment**

"Account-level Stripe throttling vs. shared rate limit pool. Check your Stripe dashboard for quota warnings."

At 3am, after reading 87% confidence and "circuit breaker deployment is the fastest recovery path," I now see a competing hypothesis that says maybe the diagnosis is wrong and I should go check the Stripe dashboard instead. This takes my focus off the action and sends me to a different product to investigate.

If confidence is 87% and the recommended action is "deploy circuit breaker," the UI should commit to that. The Competing Hypothesis box is the AI saying "actually, maybe not" immediately after saying "do this." That is not helpful uncertainty — it is actionable doubt. At best I waste 2 minutes checking Stripe dashboard. At worst I pursue the wrong path.

The competing hypothesis should either be removed from the default view, collapsed behind a "What if I'm wrong?" disclosure, or only surfaced when confidence is below ~70%.

**3. DO NOT section still does not earn its visual weight at 3am**

The "Do not" items use a small ✕ marker, muted ink-3 text, and no background color. In a visual scan, this section does not register as a warning — it reads as fine print at the bottom of the action card. At 3am I am not reading fine print.

Specifically: "Do not restart the database" is the most dangerous item on the page. It deserves amber or red background highlight, not the same density and color as a descriptive bullet point. The current styling signals "for your information" when it needs to signal "if you do this, you will make it worse."

---

## What the Move to Action-First Gets Right

- I can copy the command in under 10 seconds without reading anything else. That is a genuine improvement.
- The platform guidance comments inside the command block (Vercel / Railway paths) address the "where do I set this" gap from v1. This is exactly right.
- The numbered steps with ETA still work well.

---

## New Minor Friction (introduced in v2)

**4. Trend arrows ↓ → ↑ are ambiguous without labels**

Mitigation Watch shows `6% ↓` and `↑` next to Stripe timeout latency. What does ↓ mean for a success rate? Bad (it's falling). What does ↑ mean for latency? Bad (it's rising). The arrows read the right direction for the metric they are attached to, but the color coding (`--accent` red for ↓ and ↑ both) does not help distinguish "falling success rate" from "rising latency" — both are bad, both are red, both have arrows. The information conveyed is "this metric is bad." I already knew that from the ALERT badge. The arrow adds no new signal.

What I actually want to know: "Is this getting worse since I opened this page?" The arrow as currently implemented is a static snapshot direction (the trend when the diagnosis ran), not a live "since you've been looking at this" indicator. If it is not live, label it "trend at detection" to avoid the false impression that it is updating in real time.

**5. The headline section no longer anchors the page — it has become an afterthought**

The headline "Stripe Rate Limits Cascading into Checkout Failure" is still good text. But in v2 it sits below the action card, below the Preflight bar, below POLICY, below the command block. It is the 5th thing I read, not the 1st. It has been visually demoted from hero to body copy.

This matters because the headline does critical orientation work: it tells me what incident I am looking at before I process any instructions. Without it at the top, the action box is floating. The chips ($2.1k/hr, 212 span errors, -96 req/s) are now also below the fold of my attention by the time I reach them.

**6. Right rail gap after Competing Hypothesis**

Below "Competing Hypothesis" and the chat bubble ("Circuit breaker deployment is the fastest recovery path..."), the right rail has significant empty space before the ASK ABOUT chips. On a 1440x900 viewport this empty zone makes the right rail look unfinished. It is a design artifact of removing Operator Check from the right rail — the content did not fill back up.

---

## WHY THIS ACTION section — is it needed?

At 3am, during active incident response: no, I do not need this.

The causal chain (External → System → Incident → Impact) is useful *after* I have acted, to understand what happened and write the incident report. During the triage moment — which is what the 3am scenario is — I am not reading four cards with dashed connectors. I clicked Copy already.

The cost of this section is real: it pushes Mitigation Watch below the fold, which is the verification step that closes the loop ("did my action work?"). I need Mitigation Watch visible immediately after I act. Right now I have to scroll past a four-card diagram to find it.

Recommendation: collapse "Why This Action" by default behind a disclosure ("See reasoning"). Mitigation Watch comes up and is visible on screen immediately after the action card.

---

## Missing (still from v1 or newly identified)

- **Diagnosis freshness timestamp**: Still no "Diagnosis ran at 05:06 UTC based on last 15 minutes of data." I don't know if this 87% confidence is current. During a fast-moving incident this matters.
- **No visual link between step 3 ("Verify in Mitigation Watch") and the actual Mitigation Watch panel**: Step 3 says "see Mitigation Watch below" but there is no affordance connecting the two. A subtle anchor link or highlight-on-read would help.
- **Auth-service incident still unexplained**: 2 hours open, no correlation signal. Still creates ambient worry I have to deliberately suppress.

---

## What Works in v2 (net new)

- **Platform command comments**: The greyed-out Vercel / Railway path comments inside the code block solve the single biggest gap from v1. I now know exactly where to go on each platform. This is the highest-value addition in v2.
- **Revenue chip (-$2.1k/hr) in the headline area**: Good — it frames urgency without requiring a separate "Impact & Timeline" section.
- **Preflight content** is the right information to surface — it just needs to be repositioned below the command, not above it.
- **Removal of Impact & Timeline**: The right call. It was redundant with the causal chain and chips.

---

## Summary of Remaining Priorities

| Issue | Severity | Fix |
|---|---|---|
| Preflight fires before context | High | Move below command or into step 0 of numbered list |
| Competing Hypothesis at 3am | High | Collapse or hide above ~70% confidence threshold |
| DO NOT section visual weight | High | Add amber/red background or border, increase contrast |
| Why This Action above Mitigation Watch | High | Collapse by default; surface Mitigation Watch earlier |
| Trend arrows are ambiguous | Medium | Add label ("at detection") or make live with explicit timestamp |
| Headline demoted from hero | Medium | Consider a one-liner summary above the action box |
| Right rail empty space | Low | Fill with diagnosis timestamp or collapse rail |
