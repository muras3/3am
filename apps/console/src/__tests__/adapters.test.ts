import { describe, it, expect } from "vitest";
import {
  buildIncidentWorkspaceVM,
} from "../lib/viewmodels/adapters.js";
import type { Incident } from "../api/types.js";
import { testIncident, testPacket, testDiagnosis } from "./fixtures.js";

// ── Degrade path helpers ─────────────────────────────────────────────────────

function makeIncident(overrides: Partial<Incident>): Incident {
  return { ...testIncident, ...overrides };
}

// ── buildIncidentWorkspaceVM ─────────────────────────────────────────────────

describe("buildIncidentWorkspaceVM", () => {
  // Degrade path 5: diagnosis undefined → returns undefined
  it("returns undefined when diagnosis is absent", () => {
    const incident = makeIncident({ diagnosisResult: undefined });
    expect(buildIncidentWorkspaceVM(incident)).toBeUndefined();
  });

  it("maps action fields from recommendation", () => {
    const vm = buildIncidentWorkspaceVM(testIncident);
    expect(vm?.action.primaryText).toBe(testDiagnosis.recommendation.immediate_action);
    expect(vm?.action.rationale).toBe(testDiagnosis.recommendation.action_rationale_short);
    expect(vm?.action.doNot).toBe(testDiagnosis.recommendation.do_not);
  });

  it("maps cause fields from diagnosis", () => {
    const vm = buildIncidentWorkspaceVM(testIncident);
    expect(vm?.cause.hypothesis).toBe(testDiagnosis.summary.root_cause_hypothesis);
    expect(vm?.cause.chain).toBe(testDiagnosis.reasoning.causal_chain);
  });

  it("maps evidence counts from packet", () => {
    const vm = buildIncidentWorkspaceVM(testIncident);
    expect(vm?.evidence.traces).toBe(testPacket.evidence.representativeTraces.length);
    expect(vm?.evidence.metrics).toBe(testPacket.evidence.changedMetrics.length);
    expect(vm?.evidence.logs).toBe(testPacket.evidence.relevantLogs.length);
  });

  it("maps evidence platformEvents count from packet", () => {
    const vm = buildIncidentWorkspaceVM(testIncident);
    expect(vm?.evidence.platformEvents).toBe(
      testPacket.evidence.platformEvents.length,
    );
  });

  it("maps evidence traceCount as unique traceIds", () => {
    const vm = buildIncidentWorkspaceVM(testIncident);
    const uniqueTraces = new Set(
      testPacket.evidence.representativeTraces.map((t) => t.traceId),
    ).size;
    expect(vm?.evidence.traceCount).toBe(uniqueTraces);
  });

  it("builds timeline with events sorted chronologically", () => {
    const vm = buildIncidentWorkspaceVM(testIncident);
    expect(vm?.timeline).toBeDefined();
    const times = vm!.timeline.events.map((e) => e.time);
    const sorted = [...times].sort();
    expect(times).toEqual(sorted);
  });

  it("timeline includes window.start, triggerSignals, and window.detect", () => {
    const vm = buildIncidentWorkspaceVM(testIncident);
    const labels = vm!.timeline.events.map((e) => e.label);
    expect(labels).toContain("Incident window start");
    expect(labels).toContain("Detected");
    expect(labels).toContain("HTTP 429");
    expect(labels).toContain("error_rate > 50%");
  });

  it("timeline events have HH:mm:ss formatted times", () => {
    const vm = buildIncidentWorkspaceVM(testIncident);
    for (const evt of vm!.timeline.events) {
      expect(evt.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    }
  });

  it("timeline surface includes routes, primaryService, and dependencies", () => {
    const vm = buildIncidentWorkspaceVM(testIncident);
    expect(vm!.timeline.surface).toContain("checkout");
    expect(vm!.timeline.surface).toContain("web");
    expect(vm!.timeline.surface).toContain("stripe");
  });
});
