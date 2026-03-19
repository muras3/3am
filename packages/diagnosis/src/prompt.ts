import type { IncidentPacket } from "@3amoncall/core";

export function buildPrompt(packet: IncidentPacket): string {
  const { window, scope, triggerSignals, evidence, pointers, signalSeverity } = packet;

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
    `  Signal severity:       ${signalSeverity ?? "(not computed)"}`,
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

  const MAX_METRICS = 20;
  const MAX_LOGS = 30;
  const MAX_TRACE_REFS = 20;

  const cappedTraceRefs = pointers.traceRefs.slice(0, MAX_TRACE_REFS);
  const traceRefsSection =
    cappedTraceRefs.length > 0
      ? `${cappedTraceRefs.join(", ")}${pointers.traceRefs.length > MAX_TRACE_REFS ? ` ... and ${pointers.traceRefs.length - MAX_TRACE_REFS} more` : ""}`
      : "(none)";

  const cappedMetrics = evidence.changedMetrics.slice(0, MAX_METRICS);
  const metricsSection =
    cappedMetrics.length > 0
      ? `\n### Changed Metrics (${cappedMetrics.length}/${evidence.changedMetrics.length})\n${cappedMetrics.map((m, i) => `  [${i + 1}] ${JSON.stringify(m)}`).join("\n")}`
      : "";

  const cappedLogs = evidence.relevantLogs.slice(0, MAX_LOGS);
  const logsSection =
    cappedLogs.length > 0
      ? `\n### Relevant Logs (${cappedLogs.length}/${evidence.relevantLogs.length})\n${cappedLogs.map((l, i) => `  [${i + 1}] ${JSON.stringify(l)}`).join("\n")}`
      : "";

  const MAX_DETAILS_LENGTH = 1000;
  const eventsSection =
    evidence.platformEvents.length > 0
      ? `\n### Platform Events\n${evidence.platformEvents
          .map((e, i) => {
            if (e.details === undefined) {
              return `  [${i + 1}] ${JSON.stringify(e)}`;
            }
            const { details, ...rest } = e;
            const detailsStr = JSON.stringify(details);
            if (detailsStr.length <= MAX_DETAILS_LENGTH) {
              return `  [${i + 1}] ${JSON.stringify(e)}`;
            }
            return `  [${i + 1}] ${JSON.stringify({ ...rest, details: detailsStr.slice(0, MAX_DETAILS_LENGTH) + " [truncated]" })}`;
          })
          .join("\n")}`
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
