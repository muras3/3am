# Persona A Review — 田中さん (Solo Dev, 3am Incident)

**Reviewer persona**: Solo developer, woken at 3:14 AM by Stripe alerts. Laptop just opened. Heart racing. Goal: understand what is broken and what to do in 30 seconds.

## Verdict: WOULD act confidently in 30 seconds

The core loop works. Within 30 seconds I knew what was broken, I had a specific command to run, and I had numbered steps. That is the bar. It clears the bar.

---

## First 5 seconds

Eyes go to: **the headline** — "Stripe Rate Limits Cascading into Checkout Failure" — immediately followed by the three impact chips (212 span errors / -96 req/s / Stripe 429s).

This is the right thing. The headline does its job. In a fog of sleep deprivation, big bold text with a red-bordered action box below it is exactly what you want scanning the page.

The "IMMEDIATE ACTION" section with the left red border pulls eyes down immediately after the headline. The visual weight hierarchy is correct: headline → action box → everything else.

What I did NOT immediately notice in the first 5 seconds: the right rail "AI Copilot" with 87% confidence. It registered as sidebar noise on first scan. That is probably fine — it is supplementary information.

---

## 30-second test

**Pass.**

- (a) What's broken: Yes — Stripe 429s, no circuit breaker, 94% order failure rate. Clear.
- (b) What to do right now: Yes — set `STRIPE_CIRCUIT_OPEN=true`, redeploy checkout-service, ETA ~2 min.

The three numbered steps in the action box give me a concrete sequence. Step 3 even tells me where to look to verify it worked ("Mitigation Watch below"). That feedback loop is present, which is unusual and appreciated.

---

## Critical Issues (things that block action)

- **"POLICY" / "OPERATE" / "STEPS" sublabels slow the read**: At 3am, I don't need three sub-sections inside the action box labeled POLICY, OPERATE, STEPS. I read POLICY first, then hunt for the actual thing to do. The policy sentence ("Shed non-critical Stripe calls...") is not actionable. My eyes have to travel past it to get to the command. The cognitive cost is small but non-zero. In a real incident, I'd be clicking Copy before fully reading the policy text. There is a risk I misunderstand the scope of what I'm doing if I skip the policy.

- **The operate command is ambiguous about WHERE to set the env var**: The command box reads `STRIPE_CIRCUIT_OPEN=true → redeploy checkout-service`. Step 1 says "Set in checkout-service env". But WHERE is "checkout-service env"? Vercel dashboard? Railway? A `.env` file? A Kubernetes ConfigMap? At 3am with adrenaline running, "checkout-service env" is not specific enough. I'd lose 30-60 seconds figuring out where to go. This is a content problem, not purely a design problem — but the UI must surface platform context.

- **No timestamp for "now"**: The topbar shows `05:24:15 UTC` but my laptop clock is in JST. I had to mentally convert. The incident has been open 18 minutes. That is shown — but the **real urgency signal** (how many customers per minute are currently failing, or revenue burning rate) is buried in the bottom-grid "Revenue impact" causal chain step. The `~$2.1k/hr` figure is inside a small card at the bottom. That number should be somewhere closer to the top if you want to communicate urgency.

---

## Minor Friction (slow but not blocking)

- **"Why This Action" causal chain is below the fold**: On a 1440x900 screen the causal chain (External → System → Incident → Impact) is visible but you have to scroll slightly. At 3am I wouldn't read it before acting. It's conceptually helpful for calming your nerves post-action, but its position implies it's equally important as the action. It is not.

- **Redundant CRITICAL badges**: The topbar has "CRITICAL" badge AND the left rail has "CRIT" badge. At 1440x900 both are visible simultaneously. Redundant signal. Not harmful, but adds visual noise.

- **"Verify STRIPE_CIRCUIT_OPEN is not already set before deploying" — Operator Check in the right rail**: This is exactly the kind of gotcha that saves you from a mistake. The problem is it's in the right rail, which I was not reading at first. If this check is safety-critical (and it could be — double-setting a circuit breaker config could have side effects), it should be in the action box, not the AI sidebar. I would have missed it in a real 3am incident.

- **"DO NOT" section styling**: The "Do not" items use a very small `✕` marker and low-contrast `var(--ink-3)` text. At 3am, muted styling signals "not important". But "Do not restart the database" IS important — if I were panicking I might be tempted to restart things. The "DO NOT" section needs more visual weight.

- **auth-service open incident with HIGH severity**: The left rail shows auth-service has been open for 2 hours. Is it related? Should I care? There's zero information about whether these incidents are correlated. My first instinct at 3am would be to wonder: "wait, is the auth issue affecting checkout too?" That's a question the UI doesn't help me answer.

---

## Missing

- **Platform deployment target**: Where exactly do I set `STRIPE_CIRCUIT_OPEN=true`? Vercel / Railway / Fly / Kubernetes — the UI knows what platform I'm on, it should show me. "Go to Vercel dashboard → checkout-service → Environment Variables → add STRIPE_CIRCUIT_OPEN=true → Redeploy" is the actual workflow. Without this, step 1 requires me to navigate away and remember what platform I'm on.

- **A live "is it getting worse?" signal**: The Mitigation Watch panel shows current values (6% success rate) but no trend arrow or sparkline. Is 6% stable, improving, or actively crashing further? At 3am that distinction matters. If it's actively getting worse I need to move faster.

- **Time-to-act urgency framing**: I don't have a sense of "if you don't act in the next X minutes, Y will happen." The revenue impact figure ($2.1k/hr) is present but it's not front-loaded. An "at current rate" projection would focus the mind.

- **Direct link to where STRIPE_CIRCUIT_OPEN is set on the actual platform**: A deep-link button to the Vercel/Railway environment variable settings for checkout-service would eliminate the ~60s of context-switching.

- **Confirmation that diagnosis is fresh**: The right rail says "Based on 4 signals" with 87% confidence. When was this diagnosis run? Is it based on data from right now, or from 10 minutes ago? There's no timestamp on the diagnosis itself. If the incident is evolving fast, stale diagnosis is dangerous.

---

## What works well

- **Headline quality**: "Stripe Rate Limits Cascading into Checkout Failure" — one sentence, cause + effect, specific service. Excellent. This is what you want as the first thing your eyes land on.

- **The command copy button**: A dark terminal-style box with a "Copy" button is exactly right. I would click it immediately. The syntax highlighting of the env var name in orange is genuinely helpful for parsing at a glance.

- **Three numbered steps with ETA**: Steps 1, 2, 3 with "(ETA ~2 min)" is the right cognitive format for 3am. Numbered, specific, includes a time expectation. Step 3 points you back to Mitigation Watch for verification — that closed feedback loop is excellent.

- **"DO NOT" section existing at all**: Most incident tools tell you what TO do. This tells you what NOT to do. That is high-value in panic states. The content is right even if the styling needs more weight.

- **Mitigation Watch with target values**: `6% → target >90%` with a current/target pairing is exactly the right format. I know what winning looks like. The "ALERT / WATCH / OK" status badges are scannable.

- **Causal chain readability**: External → System → Incident → Impact with color-coded borders (amber/teal/red/red) is legible once you get there. The animated dashed connectors reinforce causality without being distracting.

- **"Could this still be deploy-related?" ask-chip**: This is the exactly right paranoid question a 3am engineer asks. Pre-seeded with a good answer. Reduces the urge to spiral into second-guessing.
