import { describe, it, expect } from "vitest";
import {
  buildIncidentWorkspaceVM,
  buildEvidenceStudioVM,
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

  // Degrade path 3: watch_items empty → RecoveryVM.items = []
  it("maps empty watch_items to empty recovery items", () => {
    const incident = makeIncident({
      diagnosisResult: {
        ...testDiagnosis,
        operator_guidance: {
          ...testDiagnosis.operator_guidance,
          watch_items: [],
        },
      },
    });
    const vm = buildIncidentWorkspaceVM(incident);
    expect(vm?.recovery.items).toEqual([]);
  });

  // Degrade path 4: watch_items with 1 item → correctly mapped
  it("correctly maps single watch_item", () => {
    const incident = makeIncident({
      diagnosisResult: {
        ...testDiagnosis,
        operator_guidance: {
          ...testDiagnosis.operator_guidance,
          watch_items: [{ label: "Error rate", state: "12%", status: "watch" }],
        },
      },
    });
    const vm = buildIncidentWorkspaceVM(incident);
    expect(vm?.recovery.items).toHaveLength(1);
    expect(vm?.recovery.items[0]).toEqual({
      look: "Error rate",
      means: "12%",
      status: "watch",
    });
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

// ── buildEvidenceStudioVM ────────────────────────────────────────────────────

describe("buildEvidenceStudioVM", () => {
  // Degrade path 1: diagnosis present + evidence sparse (no metrics/logs) → proofCards generated diagnosis-led
  it("generates proof cards diagnosis-led when metrics/logs are absent", () => {
    // testIncident has changedMetrics=[] and relevantLogs=[] but has diagnosis
    const vm = buildEvidenceStudioVM(testIncident);
    expect(vm.proofCards).toHaveLength(3);
    // sourceFamily for cards 1 and 2 should be "diagnosis" when dr is present
    expect(vm.proofCards[0]?.sourceFamily).toBe("diagnosis");
    expect(vm.proofCards[1]?.sourceFamily).toBe("diagnosis");
    // proof content comes from diagnosis
    expect(vm.proofCards[0]?.proof).toBe(testDiagnosis.reasoning.causal_chain[0]?.title);
    expect(vm.proofCards[1]?.proof).toBe(testDiagnosis.reasoning.causal_chain[1]?.title);
  });

  // Degrade path 2: affectedDependencies empty → ComponentFlow doesn't crash
  it("does not crash when affectedDependencies is empty", () => {
    const incident = makeIncident({
      packet: {
        ...testPacket,
        scope: {
          ...testPacket.scope,
          affectedDependencies: [],
        },
      },
    });
    expect(() => buildEvidenceStudioVM(incident)).not.toThrow();
    const vm = buildEvidenceStudioVM(incident);
    // primary service node should still exist
    expect(vm.componentFlow.nodes.some((n) => n.id === testPacket.scope.primaryService)).toBe(true);
    // no edges for dependencies
    expect(vm.componentFlow.edges.filter((e) => e.to === testPacket.scope.primaryService)).toHaveLength(0);
  });

  // Degrade path 6: platform/logs/metrics all empty → proofCards generated from representative traces
  it("uses representative traces as sourceFamily when all other evidence is empty", () => {
    const incident = makeIncident({
      diagnosisResult: undefined,
      packet: {
        ...testPacket,
        evidence: {
          ...testPacket.evidence,
          changedMetrics: [],
          relevantLogs: [],
          platformEvents: [],
          // representativeTraces is non-empty in testPacket
        },
      },
    });
    const vm = buildEvidenceStudioVM(incident);
    // When no diagnosis and traces exist, sourceFamily should be "traces"
    expect(vm.proofCards[2]?.sourceFamily).toBe("traces");
  });

  it("generates 3 proof cards with correct labels", () => {
    const vm = buildEvidenceStudioVM(testIncident);
    expect(vm.proofCards[0]?.label).toBe("External Trigger");
    expect(vm.proofCards[1]?.label).toBe("Design Gap");
    expect(vm.proofCards[2]?.label).toBe("Recovery Signal");
  });

  it("recovery signal card uses first watch_item when available", () => {
    const vm = buildEvidenceStudioVM(testIncident);
    const firstWatch = testDiagnosis.operator_guidance.watch_items[0]!;
    expect(vm.proofCards[2]?.proof).toBe(`${firstWatch.label}: ${firstWatch.state}`);
  });

  it("recovery card sourceFamily is operator-guidance when watch_items available", () => {
    const vm = buildEvidenceStudioVM(testIncident);
    expect(vm.proofCards[2]?.sourceFamily).toBe("operator-guidance");
  });

  it("componentFlow includes nodes for dependencies and impact services", () => {
    const vm = buildEvidenceStudioVM(testIncident);
    const nodeIds = vm.componentFlow.nodes.map((n) => n.id);
    expect(nodeIds).toContain(testPacket.scope.primaryService);
    for (const dep of testPacket.scope.affectedDependencies) {
      expect(nodeIds).toContain(dep);
    }
  });

  it("componentFlow includes edges between nodes", () => {
    const vm = buildEvidenceStudioVM(testIncident);
    expect(vm.componentFlow.edges.length).toBeGreaterThan(0);
    // Dep edges point to primary service
    const depEdges = vm.componentFlow.edges.filter(
      (e) => e.to === testPacket.scope.primaryService,
    );
    expect(depEdges.length).toBe(testPacket.scope.affectedDependencies.length);
  });

  // Degrade path for impact nodes: affectedServices sparse → supplement from causal chain
  it("adds impact nodes from causal chain when affectedServices only contains primaryService", () => {
    const incident = makeIncident({
      packet: {
        ...testPacket,
        scope: {
          ...testPacket.scope,
          affectedServices: [testPacket.scope.primaryService],
        },
      },
    });
    const vm = buildEvidenceStudioVM(incident);
    const impactNodes = vm.componentFlow.nodes.filter((n) => n.role === "impact");
    // testDiagnosis causal_chain has one "impact" step ("Revenue loss")
    expect(impactNodes.length).toBeGreaterThan(0);
    expect(
      vm.componentFlow.edges.some((e) => e.from === testPacket.scope.primaryService),
    ).toBe(true);
  });
});
