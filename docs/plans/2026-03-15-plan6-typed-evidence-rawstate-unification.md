# Plan 6: Typed Evidence Schema + Raw State Unification

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `unknown[]` evidence types with typed Zod schemas, migrate metrics/logs from `appendEvidence` (packet-direct) to `appendRawEvidence` (rawState), and make `rebuildPacket` derive ALL evidence from rawState alone — completing the ADR 0030 vision.

**Architecture:** Currently metrics/logs bypass rawState — they go straight to `packet.evidence` via `appendEvidence()`. This plan moves them into `rawState.metricEvidence` / `rawState.logEvidence` with typed schemas, then `rebuildPacket()` reads from rawState only. `appendEvidence()` and `mergeEvidenceIntoPacket()` are removed. This unifies the evidence pipeline: all 5 evidence types (spans, signals, metrics, logs, platformEvents) flow through rawState → rebuild.

**Tech Stack:** Zod (schema), Hono (ingest), Drizzle (storage adapters), Vitest (tests)

**Remediation Items Covered:** B-4 (Evidence schema too loose), B-5 (Retrieval layer mostly empty), B-6 (severity optional/unset)

---

## Scope Definition

### In Scope

1. **B-4**: Typed `ChangedMetricSchema` and `RelevantLogSchema` in `@3amoncall/core`
2. **B-4**: Replace `z.array(z.unknown())` in `EvidenceSchema` with typed arrays
3. **B-4**: New `appendRawEvidence()` method on `StorageDriver` — appends to `rawState.metricEvidence` / `rawState.logEvidence`
4. **B-4**: Ingest `/v1/metrics` and `/v1/logs` routes use `appendRawEvidence` + `rebuildPacket` instead of `appendEvidence`
5. **B-4**: Remove `appendEvidence()` and `mergeEvidenceIntoPacket()` — dead code after migration
6. **B-5**: `rebuildPacket` populates `pointers.logRefs` and `pointers.metricRefs` from rawState
7. **B-6**: Add `signalSeverity` field to packet (observed signal strength, not business severity)

### Out of Scope

- A-4 (48h close rule) — deferred
- A-5 (atomic append) — deferred (race condition acceptable Phase 1)
- Evidence selection/ranking (limit counts, relevance sorting) — future refinement
- Drizzle JSONB atomic append optimization — future

### Dependencies

- Plans 1-5 complete (confirmed)
- ADR 0030 accepted (confirmed)

---

## Pre-Work: Reference Map

### Files to Modify

| File | Role |
|------|------|
| `packages/core/src/schemas/incident-packet.ts` | Zod schemas — add `ChangedMetricSchema`, `RelevantLogSchema`, replace `unknown[]` |
| `packages/core/src/index.ts` | Export new schemas/types |
| `apps/receiver/src/storage/interface.ts` | `StorageDriver` — add `appendRawEvidence`, remove `appendEvidence`, update `IncidentRawState` types |
| `apps/receiver/src/storage/adapters/memory.ts` | `MemoryAdapter` — implement `appendRawEvidence`, remove `appendEvidence` |
| `apps/receiver/src/storage/drizzle/postgres.ts` | `PostgresAdapter` — implement `appendRawEvidence`, remove `appendEvidence` |
| `apps/receiver/src/storage/drizzle/sqlite.ts` | `SQLiteAdapter` — implement `appendRawEvidence`, remove `appendEvidence` |
| `apps/receiver/src/domain/packetizer.ts` | `rebuildPacket` — derive metrics/logs/retrieval from rawState |
| `apps/receiver/src/domain/evidence-extractor.ts` | Tighten return types to match new schemas |
| `apps/receiver/src/transport/ingest.ts` | `/v1/metrics`, `/v1/logs` — use `appendRawEvidence` + rebuild |
| `apps/receiver/src/__tests__/storage/shared-suite.ts` | Storage contract tests |
| `apps/receiver/src/__tests__/integration.test.ts` | Integration tests for ingest |

### Existing Types to Replace

```typescript
// CURRENT (interface.ts)
metricEvidence: unknown[]    // → MetricEvidence[] (from evidence-extractor.ts, promoted to core)
logEvidence: unknown[]       // → LogEvidence[] (from evidence-extractor.ts, promoted to core)

// CURRENT (incident-packet.ts EvidenceSchema)
changedMetrics: z.array(z.unknown())   // → z.array(ChangedMetricSchema)
relevantLogs: z.array(z.unknown())     // → z.array(RelevantLogSchema)
```

### Existing Types in evidence-extractor.ts

`MetricEvidence` and `LogEvidence` types already exist in `evidence-extractor.ts` with proper shapes. Plan 6 promotes these to `@3amoncall/core` as Zod schemas.

---

## Task 1: Add Typed Evidence Schemas to @3amoncall/core

**Files:**
- Modify: `packages/core/src/schemas/incident-packet.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/incident-packet.test.ts` (existing)

### Step 1: Write failing tests for new schemas

Add tests to `packages/core/src/__tests__/incident-packet.test.ts`:

```typescript
import { ChangedMetricSchema, RelevantLogSchema, IncidentPacketSchema } from "../schemas/incident-packet.js";

describe("ChangedMetricSchema", () => {
  it("accepts a valid metric evidence entry", () => {
    const valid = {
      name: "http.server.duration",
      service: "validation-web",
      environment: "staging",
      startTimeMs: 1710500000000,
      summary: { count: 42, sum: 1234.5, min: 10, max: 500 },
    };
    expect(ChangedMetricSchema.parse(valid)).toEqual(valid);
  });

  it("rejects entry missing required fields", () => {
    expect(() => ChangedMetricSchema.parse({ name: "x" })).toThrow();
  });

  it("rejects unknown fields (.strict())", () => {
    expect(() =>
      ChangedMetricSchema.parse({
        name: "x",
        service: "s",
        environment: "e",
        startTimeMs: 1,
        summary: {},
        extraField: true,
      }),
    ).toThrow();
  });
});

describe("RelevantLogSchema", () => {
  it("accepts a valid log evidence entry", () => {
    const valid = {
      service: "validation-web",
      environment: "staging",
      timestamp: "2026-03-15T00:00:00.000Z",
      startTimeMs: 1710500000000,
      severity: "ERROR",
      body: "sendgrid auth failed",
      attributes: { "error.type": "AuthenticationError" },
    };
    expect(RelevantLogSchema.parse(valid)).toEqual(valid);
  });

  it("rejects entry missing required fields", () => {
    expect(() => RelevantLogSchema.parse({ severity: "ERROR" })).toThrow();
  });

  it("rejects unknown fields (.strict())", () => {
    expect(() =>
      RelevantLogSchema.parse({
        service: "s",
        environment: "e",
        timestamp: "t",
        startTimeMs: 1,
        severity: "ERROR",
        body: "b",
        attributes: {},
        extraField: true,
      }),
    ).toThrow();
  });
});
```

### Step 2: Run tests — expect FAIL

```bash
cd /Users/murase/project/3amoncall && pnpm --filter @3amoncall/core test -- --run
```

Expected: FAIL — `ChangedMetricSchema` and `RelevantLogSchema` not exported.

### Step 3: Implement schemas

In `packages/core/src/schemas/incident-packet.ts`, add before `EvidenceSchema`:

```typescript
export const ChangedMetricSchema = z.object({
  name: z.string(),
  service: z.string(),
  environment: z.string(),
  startTimeMs: z.number(),
  summary: z.unknown(),   // histogram/gauge/sum compressed shape — heterogeneous by metric type
}).strict();

export type ChangedMetric = z.infer<typeof ChangedMetricSchema>;

export const RelevantLogSchema = z.object({
  service: z.string(),
  environment: z.string(),
  timestamp: z.string(),
  startTimeMs: z.number(),
  severity: z.string(),
  body: z.string(),
  attributes: z.record(z.string(), z.unknown()),
}).strict();

export type RelevantLog = z.infer<typeof RelevantLogSchema>;
```

Then update `EvidenceSchema`:

```typescript
const EvidenceSchema = z.object({
  changedMetrics: z.array(ChangedMetricSchema),
  representativeTraces: z.array(RepresentativeTraceSchema),
  relevantLogs: z.array(RelevantLogSchema),
  platformEvents: z.array(PlatformEventSchema),
}).strict();
```

Export from `packages/core/src/index.ts`:

```typescript
export { ChangedMetricSchema, RelevantLogSchema } from "./schemas/incident-packet.js";
export type { ChangedMetric, RelevantLog } from "./schemas/incident-packet.js";
```

### Step 4: Run tests — expect PASS

```bash
cd /Users/murase/project/3amoncall && pnpm --filter @3amoncall/core test -- --run
```

### Step 5: Build core and check downstream typecheck

```bash
cd /Users/murase/project/3amoncall && pnpm --filter @3amoncall/core build && pnpm typecheck
```

This will likely surface type errors in:
- `evidence-extractor.ts` (`MetricEvidence.summary` is `unknown` but now `ChangedMetricSchema.summary` is also `z.unknown()` — should be compatible)
- `storage/interface.ts` (`metricEvidence: unknown[]` → needs update to `ChangedMetric[]`)
- `ingest.ts` (calls `appendEvidence` with `unknown[]` — will fix in Task 3)

**Do NOT fix these errors yet** — they will be addressed in subsequent tasks. Note which files error for reference.

### Step 6: Commit

```bash
git add packages/core/src/schemas/incident-packet.ts packages/core/src/index.ts packages/core/src/__tests__/incident-packet.test.ts
git commit -m "feat(core): add ChangedMetricSchema + RelevantLogSchema, replace unknown[] in EvidenceSchema

Plan 6 / B-4 step 1: typed evidence schemas in @3amoncall/core.
Downstream type errors expected — fixed in subsequent tasks."
```

---

## Task 2: Update IncidentRawState and StorageDriver Interface

**Files:**
- Modify: `apps/receiver/src/storage/interface.ts`

### Step 1: Update IncidentRawState types

Replace `unknown[]` with typed arrays:

```typescript
import type { IncidentPacket, DiagnosisResult, PlatformEvent, ThinEvent, ChangedMetric, RelevantLog } from "@3amoncall/core";

export interface IncidentRawState {
  spans: ExtractedSpan[];
  anomalousSignals: AnomalousSignal[];
  metricEvidence: ChangedMetric[];
  logEvidence: RelevantLog[];
  platformEvents: PlatformEvent[];
}
```

### Step 2: Add appendRawEvidence, remove appendEvidence

Add to `StorageDriver`:

```typescript
  /**
   * Append metric/log evidence to an incident's raw state.
   * Unknown incidentId is a no-op (does not throw).
   */
  appendRawEvidence(
    incidentId: string,
    update: { metricEvidence?: ChangedMetric[]; logEvidence?: RelevantLog[] },
  ): Promise<void>;
```

Remove the `appendEvidence` method from `StorageDriver`.

### Step 3: Remove mergeEvidenceIntoPacket

Delete the `mergeEvidenceIntoPacket` function from `interface.ts` — it will no longer be needed after ingest migration.

### Step 4: Typecheck (expect errors in adapters + ingest)

```bash
pnpm typecheck 2>&1 | head -50
```

Note errors — adapters still implement old `appendEvidence`. Will be fixed in Task 3.

### Step 5: Commit

```bash
git add apps/receiver/src/storage/interface.ts
git commit -m "feat(receiver): update StorageDriver — appendRawEvidence replaces appendEvidence

Plan 6 / B-4 step 2: typed IncidentRawState, new appendRawEvidence method.
Adapters + ingest will be updated in next tasks."
```

---

## Task 3: Implement appendRawEvidence in All Adapters

**Files:**
- Modify: `apps/receiver/src/storage/adapters/memory.ts`
- Modify: `apps/receiver/src/storage/drizzle/postgres.ts`
- Modify: `apps/receiver/src/storage/drizzle/sqlite.ts`
- Modify: `apps/receiver/src/__tests__/storage/shared-suite.ts`

### Step 1: Write contract tests for appendRawEvidence

Add to `shared-suite.ts` after the existing `appendEvidence` tests:

```typescript
// appendRawEvidence ────────────────────────────────────────────────────

it("appendRawEvidence appends metricEvidence to rawState", async () => {
  const packet = makePacket();
  await driver.createIncident(packet);
  await driver.appendRawEvidence(packet.incidentId, {
    metricEvidence: [
      { name: "http.duration", service: "web", environment: "staging", startTimeMs: 1000, summary: { count: 1 } },
    ],
  });
  const rawState = await driver.getRawState(packet.incidentId);
  expect(rawState!.metricEvidence).toHaveLength(1);
  expect(rawState!.metricEvidence[0].name).toBe("http.duration");
});

it("appendRawEvidence appends logEvidence to rawState", async () => {
  const packet = makePacket();
  await driver.createIncident(packet);
  await driver.appendRawEvidence(packet.incidentId, {
    logEvidence: [
      { service: "web", environment: "staging", timestamp: "2026-03-15T00:00:00Z", startTimeMs: 1000, severity: "ERROR", body: "fail", attributes: {} },
    ],
  });
  const rawState = await driver.getRawState(packet.incidentId);
  expect(rawState!.logEvidence).toHaveLength(1);
  expect(rawState!.logEvidence[0].severity).toBe("ERROR");
});

it("appendRawEvidence accumulates across calls", async () => {
  const packet = makePacket();
  await driver.createIncident(packet);
  await driver.appendRawEvidence(packet.incidentId, {
    metricEvidence: [{ name: "m1", service: "s", environment: "e", startTimeMs: 1, summary: {} }],
  });
  await driver.appendRawEvidence(packet.incidentId, {
    metricEvidence: [{ name: "m2", service: "s", environment: "e", startTimeMs: 2, summary: {} }],
    logEvidence: [{ service: "s", environment: "e", timestamp: "t", startTimeMs: 1, severity: "WARN", body: "b", attributes: {} }],
  });
  const rawState = await driver.getRawState(packet.incidentId);
  expect(rawState!.metricEvidence).toHaveLength(2);
  expect(rawState!.logEvidence).toHaveLength(1);
});

it("appendRawEvidence is no-op for unknown incidentId", async () => {
  await expect(
    driver.appendRawEvidence("inc_unknown", {
      metricEvidence: [{ name: "x", service: "s", environment: "e", startTimeMs: 1, summary: {} }],
    }),
  ).resolves.toBeUndefined();
});
```

### Step 2: Remove old appendEvidence tests

Remove the 3 `appendEvidence` tests from `shared-suite.ts`:
- "appendEvidence appends changedMetrics to existing incident"
- "appendEvidence appends relevantLogs to existing incident"
- "appendEvidence is a no-op for unknown incidentId"

### Step 3: Run tests — expect FAIL

```bash
pnpm --filter receiver test -- --run
```

### Step 4: Implement in MemoryAdapter

In `memory.ts`:

```typescript
// REMOVE:
async appendEvidence(...)

// ADD:
async appendRawEvidence(
  id: string,
  update: { metricEvidence?: ChangedMetric[]; logEvidence?: RelevantLog[] },
): Promise<void> {
  const incident = this.incidents.get(id);
  if (!incident) return;
  if (update.metricEvidence) incident.rawState.metricEvidence.push(...update.metricEvidence);
  if (update.logEvidence) incident.rawState.logEvidence.push(...update.logEvidence);
}
```

Import `ChangedMetric`, `RelevantLog` from `@3amoncall/core`.
Remove `mergeEvidenceIntoPacket` import.

### Step 5: Implement in PostgresAdapter

In `postgres.ts`:

```typescript
// REMOVE: appendEvidence(...)

// ADD:
async appendRawEvidence(
  incidentId: string,
  update: { metricEvidence?: ChangedMetric[]; logEvidence?: RelevantLog[] },
): Promise<void> {
  const incident = await this.getIncident(incidentId);
  if (!incident) return;
  const rawState: IncidentRawState = {
    ...incident.rawState,
    metricEvidence: [...incident.rawState.metricEvidence, ...(update.metricEvidence ?? [])],
    logEvidence: [...incident.rawState.logEvidence, ...(update.logEvidence ?? [])],
  };
  await this.db
    .update(pgIncidents)
    .set({ rawState, updatedAt: new Date() })
    .where(eq(pgIncidents.incidentId, incidentId));
}
```

Remove `mergeEvidenceIntoPacket` import.

### Step 6: Implement in SQLiteAdapter

Same pattern as PostgresAdapter. Remove `appendEvidence`, add `appendRawEvidence`.

### Step 7: Run tests — expect PASS

```bash
pnpm --filter receiver test -- --run
```

### Step 8: Commit

```bash
git add apps/receiver/src/storage/ apps/receiver/src/__tests__/storage/shared-suite.ts
git commit -m "feat(receiver): implement appendRawEvidence in all storage adapters

Plan 6 / B-4 step 3: typed evidence goes to rawState, appendEvidence removed.
Contract tests updated: 4 new tests, 3 old tests removed."
```

---

## Task 4: Update rebuildPacket to Derive Evidence from rawState

**Files:**
- Modify: `apps/receiver/src/domain/packetizer.ts`
- Test: `apps/receiver/src/__tests__/packet-rebuild.test.ts` (existing)

### Step 1: Write failing tests

Add test cases to `packet-rebuild.test.ts`:

```typescript
describe("rebuildPacket — rawState-derived evidence (Plan 6)", () => {
  it("derives changedMetrics from rawState.metricEvidence", () => {
    const rawState = makeRawState({
      metricEvidence: [
        { name: "http.duration", service: "web", environment: "staging", startTimeMs: 1000, summary: { count: 5 } },
      ],
    });
    const packet = rebuildPacket("inc_1", "pkt_1", "2026-01-01T00:00:00Z", rawState);
    expect(packet.evidence.changedMetrics).toHaveLength(1);
    expect(packet.evidence.changedMetrics[0]).toEqual(rawState.metricEvidence[0]);
  });

  it("derives relevantLogs from rawState.logEvidence", () => {
    const rawState = makeRawState({
      logEvidence: [
        { service: "web", environment: "staging", timestamp: "2026-01-01T00:00:00Z", startTimeMs: 1000, severity: "ERROR", body: "fail", attributes: {} },
      ],
    });
    const packet = rebuildPacket("inc_1", "pkt_1", "2026-01-01T00:00:00Z", rawState);
    expect(packet.evidence.relevantLogs).toHaveLength(1);
    expect(packet.evidence.relevantLogs[0]).toEqual(rawState.logEvidence[0]);
  });

  it("populates pointers.metricRefs from rawState metrics", () => {
    const rawState = makeRawState({
      metricEvidence: [
        { name: "http.duration", service: "web", environment: "staging", startTimeMs: 1000, summary: {} },
        { name: "http.duration", service: "web", environment: "staging", startTimeMs: 2000, summary: {} },
        { name: "db.pool.usage", service: "web", environment: "staging", startTimeMs: 1500, summary: {} },
      ],
    });
    const packet = rebuildPacket("inc_1", "pkt_1", "2026-01-01T00:00:00Z", rawState);
    // metricRefs = unique metric names
    expect(packet.pointers.metricRefs).toEqual(["http.duration", "db.pool.usage"]);
  });

  it("populates pointers.logRefs from rawState logs", () => {
    const rawState = makeRawState({
      logEvidence: [
        { service: "web", environment: "staging", timestamp: "2026-01-01T00:00:00Z", startTimeMs: 1000, severity: "ERROR", body: "fail", attributes: {} },
        { service: "api", environment: "staging", timestamp: "2026-01-01T00:01:00Z", startTimeMs: 2000, severity: "WARN", body: "slow", attributes: {} },
      ],
    });
    const packet = rebuildPacket("inc_1", "pkt_1", "2026-01-01T00:00:00Z", rawState);
    // logRefs = unique "service:timestamp" keys for log retrieval
    expect(packet.pointers.logRefs).toHaveLength(2);
  });

  it("ignores existingEvidence parameter (rawState is sole source)", () => {
    const rawState = makeRawState({
      metricEvidence: [
        { name: "m1", service: "s", environment: "e", startTimeMs: 1, summary: {} },
      ],
    });
    // Pass stale existingEvidence — should be ignored
    const packet = rebuildPacket(
      "inc_1", "pkt_1", "2026-01-01T00:00:00Z", rawState,
      { changedMetrics: [{ name: "stale" }], relevantLogs: [{ body: "stale" }] },
    );
    expect(packet.evidence.changedMetrics).toHaveLength(1);
    expect(packet.evidence.changedMetrics[0].name).toBe("m1");
    expect(packet.evidence.relevantLogs).toHaveLength(0);
  });
});
```

Note: a `makeRawState` test helper will need to be added if not present, creating a minimal rawState with at least one span.

### Step 2: Run tests — expect FAIL

```bash
pnpm --filter receiver test -- --run -t "rawState-derived evidence"
```

### Step 3: Update rebuildPacket signature and implementation

In `packetizer.ts`, change `rebuildPacket`:

1. **Remove** the `existingEvidence` parameter — rawState is now the sole source
2. **Derive** `changedMetrics` from `rawState.metricEvidence`
3. **Derive** `relevantLogs` from `rawState.logEvidence`
4. **Populate** `pointers.metricRefs` = unique metric names from `rawState.metricEvidence`
5. **Populate** `pointers.logRefs` = unique `"service:timestamp"` keys from `rawState.logEvidence`

```typescript
export function rebuildPacket(
  incidentId: string,
  packetId: string,
  openedAt: string,
  rawState: IncidentRawState,
  _existingEvidence?: unknown,  // DEPRECATED — ignored, rawState is sole source
  generation?: number,
  primaryService?: string,
): IncidentPacket {
  const { spans, anomalousSignals, platformEvents, metricEvidence, logEvidence } = rawState

  // ... (window, scope, triggerSignals, representativeTraces unchanged) ...

  // evidence — all derived from rawState
  const changedMetrics = metricEvidence
  const relevantLogs = logEvidence

  // pointers
  const traceRefs = [...new Set(spans.map((s) => s.traceId))]
  const metricRefs = [...new Set(metricEvidence.map((m) => m.name))]
  const logRefs = [...new Set(logEvidence.map((l) => `${l.service}:${l.timestamp}`))]
  const platformLogRefs = platformEvents.map(buildPlatformLogRef)

  return {
    // ... (identity, window, scope, triggerSignals unchanged) ...
    evidence: {
      changedMetrics,
      representativeTraces,
      relevantLogs,
      platformEvents,
    },
    pointers: {
      traceRefs,
      logRefs,
      metricRefs,
      platformLogRefs,
    },
  }
}
```

### Step 4: Run tests — expect PASS

```bash
pnpm --filter receiver test -- --run
```

### Step 5: Commit

```bash
git add apps/receiver/src/domain/packetizer.ts apps/receiver/src/__tests__/packet-rebuild.test.ts
git commit -m "feat(receiver): rebuildPacket derives all evidence from rawState

Plan 6 / B-4 + B-5: changedMetrics/relevantLogs from rawState,
metricRefs/logRefs populated in pointers. existingEvidence param deprecated."
```

---

## Task 5: Migrate Ingest Routes to appendRawEvidence + Rebuild

**Files:**
- Modify: `apps/receiver/src/transport/ingest.ts`
- Test: `apps/receiver/src/__tests__/integration.test.ts`

### Step 1: Write/update integration tests

Add or update integration tests for the new evidence flow:

```typescript
describe("POST /v1/metrics — rawState evidence path (Plan 6)", () => {
  it("appends metric evidence to rawState and rebuilds packet", async () => {
    // Create an incident first via /v1/traces
    // POST metrics for that incident's service/environment/window
    // GET the incident — verify:
    //   - rawState.metricEvidence contains the metric
    //   - packet.evidence.changedMetrics contains the metric (via rebuild)
    //   - packet.pointers.metricRefs contains the metric name
  });
});

describe("POST /v1/logs — rawState evidence path (Plan 6)", () => {
  it("appends log evidence to rawState and rebuilds packet", async () => {
    // Create an incident first via /v1/traces
    // POST logs for that incident's service/environment/window
    // GET the incident — verify:
    //   - rawState.logEvidence contains the log
    //   - packet.evidence.relevantLogs contains the log (via rebuild)
    //   - packet.pointers.logRefs contains the log ref
  });
});
```

### Step 2: Run tests — expect FAIL

### Step 3: Update /v1/metrics route

Replace `appendEvidence` call with `appendRawEvidence` + `rebuildPacket`:

```typescript
app.post("/v1/metrics", async (c) => {
  // ... (decode, extractMetricEvidence unchanged) ...

  if (evidences.length > 0) {
    const page = await storage.listIncidents({ limit: 100 });
    await Promise.all(
      page.items.flatMap((incident) => {
        const matching = evidences.filter((e) => shouldAttachEvidence(e, incident));
        if (matching.length === 0) return [];
        return [
          (async () => {
            await storage.appendRawEvidence(incident.incidentId, { metricEvidence: matching });
            const rawState = await storage.getRawState(incident.incidentId);
            if (rawState === null) return;
            const generation = (incident.packet.generation ?? 1) + 1;
            const rebuiltPacket = rebuildPacket(
              incident.incidentId,
              incident.packet.packetId,
              incident.openedAt,
              rawState,
              undefined,
              generation,
              incident.packet.scope.primaryService,
            );
            await storage.createIncident(rebuiltPacket);
          })(),
        ];
      }),
    );
  }

  return c.json({ status: "ok" });
});
```

### Step 4: Update /v1/logs route

Same pattern as `/v1/metrics`:

```typescript
app.post("/v1/logs", async (c) => {
  // ... (decode, extractLogEvidence unchanged) ...

  if (evidences.length > 0) {
    const page = await storage.listIncidents({ limit: 100 });
    await Promise.all(
      page.items.flatMap((incident) => {
        const matching = evidences.filter((e) => shouldAttachEvidence(e, incident));
        if (matching.length === 0) return [];
        return [
          (async () => {
            await storage.appendRawEvidence(incident.incidentId, { logEvidence: matching });
            const rawState = await storage.getRawState(incident.incidentId);
            if (rawState === null) return;
            const generation = (incident.packet.generation ?? 1) + 1;
            const rebuiltPacket = rebuildPacket(
              incident.incidentId,
              incident.packet.packetId,
              incident.openedAt,
              rawState,
              undefined,
              generation,
              incident.packet.scope.primaryService,
            );
            await storage.createIncident(rebuiltPacket);
          })(),
        ];
      }),
    );
  }

  return c.json({ status: "ok" });
});
```

### Step 5: Remove appendEvidence import

Remove `mergeEvidenceIntoPacket` from any remaining imports. Verify no call sites remain:

```bash
grep -rn "appendEvidence\|mergeEvidenceIntoPacket" apps/receiver/src/
```

Expected: zero hits (except possibly comments/docs).

### Step 6: Update /v1/traces rebuild call

Remove the `existingEvidence` parameter from the rebuild call in the existing-incident path:

```typescript
// BEFORE:
const rebuiltPacket = rebuildPacket(
  incidentId, existing.packet.packetId, existing.openedAt,
  rawState, existing.packet.evidence, generation, ...
);

// AFTER:
const rebuiltPacket = rebuildPacket(
  incidentId, existing.packet.packetId, existing.openedAt,
  rawState, undefined, generation, ...
);
```

Same for the `/v1/platform-events` rebuild call.

### Step 7: Run full test suite

```bash
pnpm test
```

### Step 8: Typecheck + lint

```bash
pnpm typecheck && pnpm lint
```

### Step 9: Commit

```bash
git add apps/receiver/src/transport/ingest.ts apps/receiver/src/__tests__/integration.test.ts
git commit -m "feat(receiver): migrate metrics/logs ingest to appendRawEvidence + rebuild

Plan 6 / B-4 step 5: /v1/metrics and /v1/logs now write to rawState,
then rebuildPacket derives packet.evidence. appendEvidence removed from
all call sites."
```

---

## Task 6: Align evidence-extractor Types with Core Schemas

**Files:**
- Modify: `apps/receiver/src/domain/evidence-extractor.ts`

### Step 1: Replace local types with core imports

The local `MetricEvidence` and `LogEvidence` types in `evidence-extractor.ts` are now duplicated with `@3amoncall/core`. Replace them:

```typescript
import type { ChangedMetric, RelevantLog } from "@3amoncall/core";

// Remove local MetricEvidence type, use ChangedMetric
// Remove local LogEvidence type, use RelevantLog

export function extractMetricEvidence(body: unknown): ChangedMetric[] { ... }
export function extractLogEvidence(body: unknown): RelevantLog[] { ... }
```

Verify the shapes match exactly. If `MetricEvidence.summary` is `unknown` in extractor and `z.unknown()` in schema, they're compatible.

### Step 2: Run tests

```bash
pnpm test && pnpm typecheck
```

### Step 3: Commit

```bash
git add apps/receiver/src/domain/evidence-extractor.ts
git commit -m "refactor(receiver): use ChangedMetric/RelevantLog from @3amoncall/core

Plan 6 / B-4 step 6: single source of truth for evidence types."
```

---

## Task 7: Add signalSeverity to Packet (B-6)

**Files:**
- Modify: `packages/core/src/schemas/incident-packet.ts`
- Modify: `apps/receiver/src/domain/packetizer.ts`
- Test: `apps/receiver/src/__tests__/packet-rebuild.test.ts`

### Step 1: Write failing test

```typescript
describe("rebuildPacket — signalSeverity (Plan 6 / B-6)", () => {
  it("computes signalSeverity from anomalous signals", () => {
    const rawState = makeRawState({
      anomalousSignals: [
        { signal: "http_500", firstSeenAt: "2026-01-01T00:00:00Z", entity: "web", spanId: "s1" },
        { signal: "http_429", firstSeenAt: "2026-01-01T00:00:01Z", entity: "web", spanId: "s2" },
        { signal: "slow_span", firstSeenAt: "2026-01-01T00:00:02Z", entity: "web", spanId: "s3" },
      ],
    });
    const packet = rebuildPacket("inc_1", "pkt_1", "2026-01-01T00:00:00Z", rawState);
    // signalSeverity is deterministic from observed signals
    expect(packet.signalSeverity).toBe("high");
  });

  it("signalSeverity is 'low' when only slow spans", () => {
    const rawState = makeRawState({
      anomalousSignals: [
        { signal: "slow_span", firstSeenAt: "2026-01-01T00:00:00Z", entity: "web", spanId: "s1" },
      ],
    });
    const packet = rebuildPacket("inc_1", "pkt_1", "2026-01-01T00:00:00Z", rawState);
    expect(packet.signalSeverity).toBe("low");
  });

  it("signalSeverity is 'medium' for non-5xx errors", () => {
    const rawState = makeRawState({
      anomalousSignals: [
        { signal: "http_429", firstSeenAt: "2026-01-01T00:00:00Z", entity: "web", spanId: "s1" },
      ],
    });
    const packet = rebuildPacket("inc_1", "pkt_1", "2026-01-01T00:00:00Z", rawState);
    expect(packet.signalSeverity).toBe("medium");
  });
});
```

### Step 2: Design signalSeverity derivation

Deterministic rules based on observed signals (NOT business impact):

| Signal types present | signalSeverity |
|---------------------|----------------|
| `http_5xx` or `exception` | `"high"` |
| `http_429` or `span_error` | `"medium"` |
| `slow_span` only | `"low"` |

Take the maximum severity across all signals.

### Step 3: Add to schema

In `incident-packet.ts`:

```typescript
export const IncidentPacketSchema = z.object({
  // ...existing fields...
  signalSeverity: z.enum(["low", "medium", "high"]).optional(),
  // ...
}).strict();
```

### Step 4: Implement in rebuildPacket

```typescript
function computeSignalSeverity(signals: AnomalousSignal[]): "low" | "medium" | "high" {
  let level = 0;
  for (const sig of signals) {
    if (/^http_5\d\d$/.test(sig.signal) || sig.signal === "exception") {
      return "high"; // short-circuit
    }
    if (sig.signal === "http_429" || sig.signal === "span_error") {
      level = Math.max(level, 1);
    }
  }
  return level >= 1 ? "medium" : "low";
}
```

Add to rebuildPacket return:

```typescript
signalSeverity: computeSignalSeverity(anomalousSignals),
```

### Step 5: Run tests — expect PASS

```bash
pnpm test && pnpm typecheck
```

### Step 6: Commit

```bash
git add packages/core/src/schemas/incident-packet.ts apps/receiver/src/domain/packetizer.ts apps/receiver/src/__tests__/packet-rebuild.test.ts
git commit -m "feat(receiver): add signalSeverity — deterministic observed signal strength

Plan 6 / B-6: high (5xx/exception), medium (429/span_error), low (slow only).
Explicitly NOT business severity — that's diagnosis/operator judgement."
```

---

## Task 8: Final Cleanup + Full Verification

**Files:**
- All modified files
- Remediation plan doc

### Step 1: Run full suite

```bash
pnpm build && pnpm test && pnpm typecheck && pnpm lint
```

### Step 2: Verify no dead code

```bash
grep -rn "appendEvidence\|mergeEvidenceIntoPacket" apps/ packages/
grep -rn "unknown\[\]" packages/core/src/schemas/incident-packet.ts
grep -rn "unknown\[\]" apps/receiver/src/storage/interface.ts
```

Expected: `appendEvidence` / `mergeEvidenceIntoPacket` — zero hits in production code. `unknown[]` — zero hits in evidence-related schemas (note: `summary: z.unknown()` in `ChangedMetricSchema` is intentional — metric summary shapes vary by type).

### Step 3: Verify IncidentPacketSchema still passes existing packet fixtures

```bash
pnpm --filter @3amoncall/core test -- --run
pnpm --filter receiver test -- --run
```

### Step 4: Update remediation plan status

Update `docs/plans/2026-03-13-incident-packet-remediation-plan.md`:
- B-4: `open` → `done`
- B-5: `open` → `done`
- B-6: `open` → `done`

### Step 5: Final commit

```bash
git add docs/plans/2026-03-13-incident-packet-remediation-plan.md
git commit -m "docs(plan): mark B-4, B-5, B-6 as done — Plan 6 complete

Evidence typed, rawState unified, retrieval populated, signalSeverity added."
```

---

## Completion Criteria (from remediation plan)

### B-4 Done When
- [x] `changedMetrics` / `relevantLogs` / `platformEvents` have typed schemas
- [x] `unknown[]` removed from packet contract
- [x] Evidence selection policy documented in code/comments

### B-5 Done When
- [x] Retrieval layer has trace + metric + log + platform refs
- [x] Consumer tests verify refs are populated

### B-6 Done When
- [x] `signalSeverity` defined on packet contract
- [x] Business severity vs signal severity documented in code/schema

### ADR 0030 Compliance
- [x] `appendEvidence()` replaced by `appendRawEvidence()`
- [x] rawState is single source of truth for ALL evidence types
- [x] `rebuildPacket` reads from rawState only

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Existing tests rely on `unknown[]` typing | Task 1 schema change is backward-compatible (existing valid data still parses) |
| `appendEvidence` removal breaks something | Search all call sites before removal; tests catch regressions |
| `summary: z.unknown()` in ChangedMetricSchema | Intentional — histogram/gauge/sum shapes vary; typed per-metric-type schema deferred |
| Race condition on concurrent metric/log + rebuild | Accepted in Phase 1 per ADR 0030; same risk as current `appendEvidence` |
| signalSeverity heuristic too simple | Explicitly documented as "observed signal strength" — refinement is future work |

---

## Sequence Diagram

```
/v1/metrics POST
  → extractMetricEvidence(body)
  → for each matching incident:
      → storage.appendRawEvidence(incidentId, { metricEvidence })
      → storage.getRawState(incidentId)
      → rebuildPacket(rawState)  ← derives changedMetrics + metricRefs from rawState
      → storage.createIncident(rebuiltPacket)

/v1/logs POST
  → extractLogEvidence(body)
  → for each matching incident:
      → storage.appendRawEvidence(incidentId, { logEvidence })
      → storage.getRawState(incidentId)
      → rebuildPacket(rawState)  ← derives relevantLogs + logRefs from rawState
      → storage.createIncident(rebuiltPacket)
```

After Plan 6, ALL evidence flows through rawState → rebuildPacket:
- spans → rawState.spans → representativeTraces + traceRefs
- anomalousSignals → rawState.anomalousSignals → triggerSignals + signalSeverity
- metrics → rawState.metricEvidence → changedMetrics + metricRefs
- logs → rawState.logEvidence → relevantLogs + logRefs
- platformEvents → rawState.platformEvents → platformEvents + platformLogRefs
