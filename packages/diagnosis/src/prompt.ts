import type { IncidentPacket } from "@3amoncall/core";

export function buildPrompt(packet: IncidentPacket): string {
  const { window, scope, triggerSignals, evidence, pointers } = packet;

  const windowSection = [
    `  Start:    ${window.start}`,
    `  Detected: ${window.detect}`,
    `  End:      ${window.end}`,
  ].join("\n");

  const scopeSection = [
    `  Environment:           ${scope.environment}`,
    `  Primary service:       ${scope.primaryService}`,
    `  Affected services:     ${scope.affectedServices.join(", ")}`,
    `  Affected routes:       ${scope.affectedRoutes.join(", ")}`,
    `  Affected dependencies: ${scope.affectedDependencies.join(", ") || "(none)"}`,
  ].join("\n");

  const signalsSection = triggerSignals
    .map(
      (s, i) =>
        `  [${i + 1}] signal=${s.signal}  firstSeenAt=${s.firstSeenAt}  entity=${s.entity}`,
    )
    .join("\n");

  const tracesSection = evidence.representativeTraces
    .map(
      (t, i) =>
        `  [${i + 1}] traceId=${t.traceId}  spanId=${t.spanId}  service=${t.serviceName}  durationMs=${t.durationMs}  httpStatus=${t.httpStatusCode ?? "n/a"}  spanStatus=${t.spanStatusCode}`,
    )
    .join("\n");

  const traceRefsSection =
    pointers.traceRefs.length > 0
      ? pointers.traceRefs.join(", ")
      : "(none)";

  const metricsSection =
    evidence.changedMetrics.length > 0
      ? `\n### Changed Metrics\n${evidence.changedMetrics.map((m, i) => `  [${i + 1}] ${JSON.stringify(m)}`).join("\n")}`
      : "";

  const logsSection =
    evidence.relevantLogs.length > 0
      ? `\n### Relevant Logs\n${evidence.relevantLogs.map((l, i) => `  [${i + 1}] ${JSON.stringify(l)}`).join("\n")}`
      : "";

  const eventsSection =
    evidence.platformEvents.length > 0
      ? `\n### Platform Events\n${evidence.platformEvents.map((e, i) => `  [${i + 1}] ${JSON.stringify(e)}`).join("\n")}`
      : "";

  return `You are an expert SRE performing on-call incident diagnosis.

## Incident Data

### Time Window
${windowSection}

### Scope
${scopeSection}

### Trigger Signals
${signalsSection}

### Representative Traces
${tracesSection}${metricsSection}${logsSection}${eventsSection}

### Trace References
  ${traceRefsSection}

---

## 7-Step SRE Investigation

Work through each step in your reasoning before producing output.

Step 1: Triage
  - What is broken?
  - Who is affected?
  - When did it start?

Step 2: Quantify Changes
  Score each dimension 0–100 for likelihood of being the cause:
  - Deployments
  - Traffic volume
  - External dependencies
  - Internal resources (DB, cache, queues)
  - Scheduled jobs / cron

Step 3: Map Dependencies
  - Identify external vs internal components
  - Identify shared resources (connection pools, queues, rate limits)
  - Determine which services are sources vs victims of the failure

Step 4: Trace Error Responses
  For each error signal:
  - What triggered it?
  - How did the system react?
  - What downstream resource was impacted?

Step 5: Form and Test Hypotheses
  - Enumerate at least 3 candidate root causes
  - For each, find evidence that would disprove it
  - Select the hypothesis best supported by the data

Step 6: Determine Recovery Action
  - What is the minimum action that stops the blast radius?
  - What actions would make things worse — explicitly list them

Step 7: Verify Reasoning
  - Counterfactual test: if this root cause did not exist, would the incident still happen?
  - Controllability test: is the recommended action actually within the operator's control?

---

## Required Output Format

Respond with ONLY the JSON object below. No prose, no markdown, no explanation before or after.

{
  "summary": {
    "what_happened": "...",
    "root_cause_hypothesis": "..."
  },
  "recommendation": {
    "immediate_action": "...",
    "action_rationale_short": "...",
    "do_not": "..."
  },
  "reasoning": {
    "causal_chain": [
      {"type": "external|system|incident|impact", "title": "...", "detail": "..."}
    ]
  },
  "operator_guidance": {
    "watch_items": [{"label": "...", "state": "...", "status": "watch|ok|alert"}],
    "operator_checks": ["..."]
  },
  "confidence": {
    "confidence_assessment": "...",
    "uncertainty": "..."
  }
}
`;
}
