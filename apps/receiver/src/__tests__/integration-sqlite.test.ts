/**
 * Integration tests: full OTLP ingest flow with SQLiteAdapter (better-sqlite3, :memory:).
 *
 * Verifies JSON serialisation/deserialisation round-trips through the entire
 * POST /v1/traces -> anomaly detection -> packetizer -> SQLite -> API response path.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteAdapter } from "../storage/drizzle/sqlite.js";
import { createApp } from "../index.js";
import { errorSpanPayload, makeDiagnosisFixture, postTraces } from "./fixtures/integration-helpers.js";

// ── Tests ───────────────────────────────────────────────────────────────────────
describe("Integration: SQLite full ingest flow", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    delete process.env["RECEIVER_AUTH_TOKEN"];
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    // SQLiteAdapter constructor auto-migrates, no migrate() needed
    const storage = new SQLiteAdapter(":memory:");
    app = createApp(storage);
  });

  afterEach(() => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
  });

  // Test 1: OTLP error span -> incident created with valid packet
  it("OTLP error span creates incident with valid packet", async () => {
    const { incidentId } = await postTraces(app);

    const res = await app.request(`/api/incidents/${incidentId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      incidentId: string;
      packet: { triggerSignals: Array<{ signal: string }> };
    };
    expect(body.incidentId).toBe(incidentId);
    // triggerSignals should contain the anomalous signal from the error span
    expect(body.packet.triggerSignals.length).toBeGreaterThan(0);
  });

  // Test 2: GET /api/incidents/:id returns incident without rawState
  it("GET /api/incidents/:id returns incident without rawState", async () => {
    const { incidentId } = await postTraces(app);

    const res = await app.request(`/api/incidents/${incidentId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { incidentId: string; rawState?: unknown };
    expect(body.incidentId).toBe(incidentId);
    expect(body.rawState).toBeUndefined();
  });

  // Test 3: GET /api/packets/:packetId returns packet with correct schemaVersion
  it("GET /api/packets/:packetId returns packet with schemaVersion incident-packet/v1alpha1", async () => {
    const { packetId } = await postTraces(app);

    const res = await app.request(`/api/packets/${packetId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schemaVersion: string };
    expect(body.schemaVersion).toBe("incident-packet/v1alpha1");
  });

  // Test 4: appendDiagnosis -> getIncident has diagnosisResult
  it("POST diagnosis then GET incident returns diagnosisResult", async () => {
    const { incidentId } = await postTraces(app);

    const diagnosisFixture = makeDiagnosisFixture(incidentId);
    const diagRes = await app.request(`/api/diagnosis/${incidentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(diagnosisFixture),
    });
    expect(diagRes.status).toBe(200);

    const res = await app.request(`/api/incidents/${incidentId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      diagnosisResult?: { summary: { what_happened: string } };
    };
    expect(body.diagnosisResult).toBeDefined();
    expect(body.diagnosisResult?.summary.what_happened).toBe(
      "Stripe 429s caused checkout 504s.",
    );
  });

  // Test 5: second OTLP POST preserves diagnosisResult
  it("second OTLP POST preserves diagnosisResult", async () => {
    // Step 1: create incident via error span
    const { incidentId } = await postTraces(app);

    // Step 2: append diagnosis
    const diagnosisFixture = makeDiagnosisFixture(incidentId);
    const diagRes = await app.request(`/api/diagnosis/${incidentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(diagnosisFixture),
    });
    expect(diagRes.status).toBe(200);

    // Step 3: send same OTLP payload again (triggers attach via shouldAttachToIncident)
    const res2 = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { incidentId: string };
    // Same incident reused (formation key matches within 5-minute window)
    expect(body2.incidentId).toBe(incidentId);

    // Step 4: verify incident still has packet and diagnosisResult
    const incRes = await app.request(`/api/incidents/${incidentId}`);
    expect(incRes.status).toBe(200);
    const incBody = (await incRes.json()) as {
      incidentId: string;
      packet: { triggerSignals: Array<{ signal: string }> };
      diagnosisResult?: { summary: { what_happened: string } };
    };
    // triggerSignals should reflect the error spans
    expect(incBody.packet.triggerSignals.length).toBeGreaterThan(0);

    // Step 5: verify diagnosisResult preserved
    expect(incBody.diagnosisResult).toBeDefined();
    expect(incBody.diagnosisResult?.summary.what_happened).toBe(
      "Stripe 429s caused checkout 504s.",
    );
  });
});
