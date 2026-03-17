# Diagnosis Quiet Period Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Delay thin event dispatch after incident creation until enough evidence accumulates, using a dual-trigger: generation threshold (default 50) OR max wait time (default 3 min).

**Architecture:** New `DiagnosisDebouncer` class holds per-incident in-memory timers. After each `rebuildSnapshots` call, `ingest.ts` checks the current packet generation against the threshold. A max-wait `setTimeout` fires as a safety net. Whichever trigger fires first dispatches the thin event; the other is cancelled. `DIAGNOSIS_DELAY_MS=0` bypasses all debouncing (backward compat).

**Tech Stack:** Node.js `setTimeout`/`clearTimeout`, vitest fake timers

---

## Task 1: Create DiagnosisDebouncer class + unit tests

**Files:**
- Create: `apps/receiver/src/runtime/diagnosis-debouncer.ts`
- Create: `apps/receiver/src/runtime/__tests__/diagnosis-debouncer.test.ts`

**Step 1: Write the failing tests**

```typescript
// diagnosis-debouncer.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DiagnosisDebouncer } from "../diagnosis-debouncer.js";

describe("DiagnosisDebouncer", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("fires callback when generation threshold is reached", async () => {
    const cb = vi.fn();
    const debouncer = new DiagnosisDebouncer({
      generationThreshold: 5,
      maxWaitMs: 180_000,
      onReady: cb,
    });
    debouncer.track("inc_1");
    debouncer.onGenerationUpdate("inc_1", 5);
    expect(cb).toHaveBeenCalledWith("inc_1");
  });

  it("fires callback on max wait timeout even if generation is low", async () => {
    const cb = vi.fn();
    const debouncer = new DiagnosisDebouncer({
      generationThreshold: 50,
      maxWaitMs: 10_000,
      onReady: cb,
    });
    debouncer.track("inc_1");
    vi.advanceTimersByTime(10_000);
    expect(cb).toHaveBeenCalledWith("inc_1");
  });

  it("does not fire twice (generation wins, timer cancelled)", async () => {
    const cb = vi.fn();
    const debouncer = new DiagnosisDebouncer({
      generationThreshold: 3,
      maxWaitMs: 60_000,
      onReady: cb,
    });
    debouncer.track("inc_1");
    debouncer.onGenerationUpdate("inc_1", 3);
    vi.advanceTimersByTime(60_000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does not fire twice (timer wins, generation after is no-op)", async () => {
    const cb = vi.fn();
    const debouncer = new DiagnosisDebouncer({
      generationThreshold: 50,
      maxWaitMs: 5_000,
      onReady: cb,
    });
    debouncer.track("inc_1");
    vi.advanceTimersByTime(5_000);
    debouncer.onGenerationUpdate("inc_1", 50);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("tracks multiple incidents independently", async () => {
    const cb = vi.fn();
    const debouncer = new DiagnosisDebouncer({
      generationThreshold: 10,
      maxWaitMs: 60_000,
      onReady: cb,
    });
    debouncer.track("inc_1");
    debouncer.track("inc_2");
    debouncer.onGenerationUpdate("inc_1", 10);
    expect(cb).toHaveBeenCalledWith("inc_1");
    expect(cb).not.toHaveBeenCalledWith("inc_2");
  });

  it("onGenerationUpdate for untracked incident is no-op", () => {
    const cb = vi.fn();
    const debouncer = new DiagnosisDebouncer({
      generationThreshold: 5,
      maxWaitMs: 60_000,
      onReady: cb,
    });
    debouncer.onGenerationUpdate("inc_unknown", 100);
    expect(cb).not.toHaveBeenCalled();
  });

  it("does not fire below threshold", () => {
    const cb = vi.fn();
    const debouncer = new DiagnosisDebouncer({
      generationThreshold: 50,
      maxWaitMs: 180_000,
      onReady: cb,
    });
    debouncer.track("inc_1");
    debouncer.onGenerationUpdate("inc_1", 49);
    expect(cb).not.toHaveBeenCalled();
  });

  it("dispose cancels all timers", () => {
    const cb = vi.fn();
    const debouncer = new DiagnosisDebouncer({
      generationThreshold: 50,
      maxWaitMs: 10_000,
      onReady: cb,
    });
    debouncer.track("inc_1");
    debouncer.dispose();
    vi.advanceTimersByTime(10_000);
    expect(cb).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd apps/receiver && npx vitest run src/runtime/__tests__/diagnosis-debouncer.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// diagnosis-debouncer.ts
export interface DiagnosisDebouncerOptions {
  /** Fire when packet generation >= this value. */
  generationThreshold: number;
  /** Fire after this many ms from track(), regardless of generation. */
  maxWaitMs: number;
  /** Callback when diagnosis should be dispatched. */
  onReady: (incidentId: string) => void;
}

interface TrackedIncident {
  timer: ReturnType<typeof setTimeout>;
  fired: boolean;
}

/**
 * Delays thin event dispatch until either:
 * 1. Packet generation reaches the threshold, or
 * 2. Max wait time elapses from incident creation.
 *
 * In-memory only — suitable for MemoryAdapter (local dev, Phase 1).
 */
export class DiagnosisDebouncer {
  private readonly opts: DiagnosisDebouncerOptions;
  private readonly tracked = new Map<string, TrackedIncident>();

  constructor(opts: DiagnosisDebouncerOptions) {
    this.opts = opts;
  }

  /** Start tracking a newly created incident. */
  track(incidentId: string): void {
    if (this.tracked.has(incidentId)) return;
    const timer = setTimeout(() => this.fire(incidentId), this.opts.maxWaitMs);
    this.tracked.set(incidentId, { timer, fired: false });
  }

  /** Called after each rebuildSnapshots — check generation threshold. */
  onGenerationUpdate(incidentId: string, generation: number): void {
    const entry = this.tracked.get(incidentId);
    if (!entry || entry.fired) return;
    if (generation >= this.opts.generationThreshold) {
      this.fire(incidentId);
    }
  }

  /** Cancel all timers (for graceful shutdown / tests). */
  dispose(): void {
    for (const entry of this.tracked.values()) {
      clearTimeout(entry.timer);
    }
    this.tracked.clear();
  }

  private fire(incidentId: string): void {
    const entry = this.tracked.get(incidentId);
    if (!entry || entry.fired) return;
    entry.fired = true;
    clearTimeout(entry.timer);
    this.opts.onReady(incidentId);
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd apps/receiver && npx vitest run src/runtime/__tests__/diagnosis-debouncer.test.ts`
Expected: all 8 tests PASS

**Step 5: Commit**

```bash
git add apps/receiver/src/runtime/diagnosis-debouncer.ts apps/receiver/src/runtime/__tests__/diagnosis-debouncer.test.ts
git commit -m "feat(receiver): add DiagnosisDebouncer class with unit tests"
```

---

## Task 2: Wire DiagnosisDebouncer into ingest.ts + index.ts

**Files:**
- Modify: `apps/receiver/src/index.ts` — read env vars, create debouncer, pass to ingest router
- Modify: `apps/receiver/src/transport/ingest.ts` — accept debouncer, replace direct dispatchThinEvent with debouncer.track()

**Step 1: Modify `index.ts` — add env var reading and debouncer creation**

Add to `AppOptions`:
```typescript
/** DiagnosisDebouncer instance. Auto-created from env vars when not provided. */
diagnosisDebouncer?: DiagnosisDebouncer;
```

In `createApp()`, after telemetryStore creation:
```typescript
import { DiagnosisDebouncer } from "./runtime/diagnosis-debouncer.js";

// Diagnosis quiet period (env-configurable)
const generationThreshold = parseInt(process.env["DIAGNOSIS_GENERATION_THRESHOLD"] ?? "50", 10);
const maxWaitMs = parseInt(process.env["DIAGNOSIS_MAX_WAIT_MS"] ?? "180000", 10);
const diagnosisDebouncer = options?.diagnosisDebouncer ?? (
  (generationThreshold === 0 && maxWaitMs === 0)
    ? undefined  // both 0 → immediate dispatch (backward compat)
    : new DiagnosisDebouncer({
        generationThreshold: generationThreshold || Infinity,  // 0 → only max wait triggers
        maxWaitMs: maxWaitMs || Infinity,  // 0 → only generation triggers
        onReady: async (incidentId) => {
          const incident = await store.getIncident(incidentId);
          if (!incident) return;
          await dispatchThinEvent({
            event_id: "evt_" + randomUUID(),
            event_type: "incident.created",
            incident_id: incidentId,
            packet_id: incident.packet.packetId,
          });
        },
      })
);
```

Pass `diagnosisDebouncer` to `createIngestRouter`.

**Step 2: Modify `ingest.ts` — accept and use debouncer**

Change signature:
```typescript
export function createIngestRouter(
  storage: StorageDriver,
  spanBuffer: SpanBuffer | undefined,
  telemetryStore: TelemetryStoreDriver,
  diagnosisDebouncer?: DiagnosisDebouncer,
): Hono {
```

In the **new incident** path (currently L306–L317), replace:
```typescript
// BEFORE:
await rebuildSnapshots(incidentId, telemetryStore, storage);
const thinEvent = { ... };
await storage.saveThinEvent(thinEvent);
await dispatchThinEvent(thinEvent);

// AFTER:
await rebuildSnapshots(incidentId, telemetryStore, storage);
if (diagnosisDebouncer) {
  diagnosisDebouncer.track(incidentId);
  // Generation check happens in the shared post-rebuild path below
} else {
  // Immediate dispatch (DIAGNOSIS_GENERATION_THRESHOLD=0 + DIAGNOSIS_MAX_WAIT_MS=0)
  const thinEvent = {
    event_id: "evt_" + randomUUID(),
    event_type: "incident.created" as const,
    incident_id: incidentId,
    packet_id: packet.packetId,
  };
  await storage.saveThinEvent(thinEvent);
  await dispatchThinEvent(thinEvent);
}
```

After **every** `rebuildSnapshots()` call (all 7 locations in ingest.ts), add generation check:
```typescript
await rebuildSnapshots(incidentId, telemetryStore, storage);
if (diagnosisDebouncer) {
  const updated = await storage.getIncident(incidentId);
  if (updated) {
    diagnosisDebouncer.onGenerationUpdate(incidentId, updated.packet.generation ?? 1);
  }
}
```

Extract a helper to avoid repeating this 7 times:
```typescript
async function rebuildAndNotify(
  incidentId: string,
  telemetryStore: TelemetryStoreDriver,
  storage: StorageDriver,
  debouncer?: DiagnosisDebouncer,
): Promise<void> {
  await rebuildSnapshots(incidentId, telemetryStore, storage);
  if (debouncer) {
    const updated = await storage.getIncident(incidentId);
    if (updated) {
      debouncer.onGenerationUpdate(incidentId, updated.packet.generation ?? 1);
    }
  }
}
```

Replace all 7 `rebuildSnapshots(...)` calls with `rebuildAndNotify(...)`.

**Step 3: Also persist thin event in onReady callback**

The `onReady` callback in `index.ts` must also call `storage.saveThinEvent(thinEvent)` before `dispatchThinEvent`.

**Step 4: Commit**

```bash
git add apps/receiver/src/index.ts apps/receiver/src/transport/ingest.ts
git commit -m "feat(receiver): wire DiagnosisDebouncer into ingest pipeline"
```

---

## Task 3: Integration test — generation threshold fires dispatch

**Files:**
- Create: `apps/receiver/src/__tests__/diagnosis-debouncer-integration.test.ts`

**Step 1: Write the integration test**

```typescript
// diagnosis-debouncer-integration.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryAdapter } from "../storage/adapters/memory.js";
import { createApp } from "../index.js";

// Mock dispatchThinEvent to capture calls
vi.mock("../runtime/github-dispatch.js", () => ({
  dispatchThinEvent: vi.fn().mockResolvedValue(undefined),
}));
import { dispatchThinEvent } from "../runtime/github-dispatch.js";

const errorSpanPayload = (traceId: string, spanId: string) => ({
  resourceSpans: [{
    resource: {
      attributes: [
        { key: "service.name", value: { stringValue: "web" } },
        { key: "deployment.environment.name", value: { stringValue: "production" } },
      ],
    },
    scopeSpans: [{
      spans: [{
        traceId,
        spanId,
        name: "POST /checkout",
        startTimeUnixNano: "1741392000000000000",
        endTimeUnixNano: "1741392000500000000",
        status: { code: 2 },
        attributes: [
          { key: "http.route", value: { stringValue: "/checkout" } },
          { key: "http.response.status_code", value: { intValue: 500 } },
        ],
      }],
    }],
  }],
});

describe("Diagnosis debouncer integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env["RECEIVER_AUTH_TOKEN"];
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    vi.mocked(dispatchThinEvent).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
    delete process.env["DIAGNOSIS_GENERATION_THRESHOLD"];
    delete process.env["DIAGNOSIS_MAX_WAIT_MS"];
  });

  it("does NOT dispatch immediately when debouncer is active", async () => {
    process.env["DIAGNOSIS_GENERATION_THRESHOLD"] = "5";
    process.env["DIAGNOSIS_MAX_WAIT_MS"] = "180000";
    const app = createApp(new MemoryAdapter());

    await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload("t1", "s1")),
    });

    expect(dispatchThinEvent).not.toHaveBeenCalled();
  });

  it("dispatches on max wait timeout", async () => {
    process.env["DIAGNOSIS_GENERATION_THRESHOLD"] = "999";
    process.env["DIAGNOSIS_MAX_WAIT_MS"] = "5000";
    const app = createApp(new MemoryAdapter());

    await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload("t1", "s1")),
    });

    expect(dispatchThinEvent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    // onReady is async — flush microtasks
    await vi.runAllTimersAsync();
    expect(dispatchThinEvent).toHaveBeenCalledTimes(1);
  });

  it("dispatches immediately when both thresholds are 0 (backward compat)", async () => {
    process.env["DIAGNOSIS_GENERATION_THRESHOLD"] = "0";
    process.env["DIAGNOSIS_MAX_WAIT_MS"] = "0";
    const app = createApp(new MemoryAdapter());

    await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload("t1", "s1")),
    });

    expect(dispatchThinEvent).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run tests**

Run: `cd apps/receiver && npx vitest run src/__tests__/diagnosis-debouncer-integration.test.ts`
Expected: all 3 tests PASS

**Step 3: Commit**

```bash
git add apps/receiver/src/__tests__/diagnosis-debouncer-integration.test.ts
git commit -m "test(receiver): add integration tests for diagnosis debouncer"
```

---

## Task 4: Update existing tests + run full suite

**Files:**
- Modify: tests that depend on immediate `dispatchThinEvent` behavior

**Step 1: Check that existing tests still pass**

The existing integration tests don't mock `dispatchThinEvent` (it no-ops because GITHUB_TOKEN is unset). With the debouncer active (default env), the thin event is no longer saved immediately — but the debouncer callback will save it on timer expiry.

Tests that check `storage.saveThinEvent` on the response path may need env override `DIAGNOSIS_GENERATION_THRESHOLD=0` + `DIAGNOSIS_MAX_WAIT_MS=0` to preserve immediate behavior in tests, OR the tests simply don't assert on thin events.

Run full suite to find breakages:

Run: `cd apps/receiver && npx vitest run`
Expected: identify any failures

**Step 2: Fix any broken tests**

For any test that expects immediate thin event behavior, add to beforeEach:
```typescript
process.env["DIAGNOSIS_GENERATION_THRESHOLD"] = "0";
process.env["DIAGNOSIS_MAX_WAIT_MS"] = "0";
```

**Step 3: Run full suite again**

Run: `cd apps/receiver && npx vitest run`
Expected: all tests PASS

**Step 4: Run monorepo checks**

Run: `pnpm typecheck && pnpm lint`
Expected: clean

**Step 5: Commit**

```bash
git add -u
git commit -m "fix(receiver): ensure existing tests work with diagnosis debouncer defaults"
```

---

## Task 5: Create PR

**Step 1: Push and create PR**

```bash
git push -u origin feat/diagnosis-quiet-period
gh pr create --base develop --title "feat(receiver): diagnosis quiet period with generation threshold" --body "..."
```

PR body should cover:
- Problem: generation=1 packet has thin evidence
- Solution: dual-trigger debouncer (generation threshold + max wait)
- Env vars: `DIAGNOSIS_GENERATION_THRESHOLD` (default 50), `DIAGNOSIS_MAX_WAIT_MS` (default 180000)
- Backward compat: both=0 → immediate dispatch
- Scope: in-memory only (Phase 1, MemoryAdapter)
