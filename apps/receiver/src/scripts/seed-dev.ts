/**
 * Seed script for local development — injects 5 scenario fixtures into the Receiver.
 *
 * Usage:
 *   RECEIVER_AUTH_TOKEN=dev tsx apps/receiver/src/scripts/seed-dev.ts [--url=http://localhost:4318]
 *
 * The script:
 *  1. POSTs a realistic anomalous OTLP trace span per scenario to /v1/traces.
 *     The Receiver's anomaly detector fires, creating an incident + packet in storage.
 *  2. Takes the returned incidentId and POSTs the scenario's DiagnosisResult to
 *     /api/diagnosis/:incidentId (patching metadata.incident_id and metadata.packet_id
 *     to match the live-generated IDs).
 *
 * The IncidentPackets in the scenario fixture files are authoritative documentation of
 * what each scenario looks like — they are used directly in unit tests. The seed script
 * uses the DiagnosisResult fixtures and generates packets via the Receiver's real pipeline.
 */

import { diagnosis as d01 } from "../__tests__/fixtures/scenarios/01-rate-limit-cascade.js";
import { diagnosis as d02 } from "../__tests__/fixtures/scenarios/02-cascading-timeout.js";
import { diagnosis as d03 } from "../__tests__/fixtures/scenarios/03-db-migration-lock.js";
import { diagnosis as d04 } from "../__tests__/fixtures/scenarios/04-secrets-rotation.js";
import { diagnosis as d05 } from "../__tests__/fixtures/scenarios/05-cdn-cache-poison.js";
import type { DiagnosisResult } from "3am-core";

const BASE_URL =
  process.argv.find((a) => a.startsWith("--url="))?.split("=")[1] ??
  "http://localhost:4318";
const TOKEN = process.env["RECEIVER_AUTH_TOKEN"] ?? "dev";

// Scenario descriptors: one OTLP span per scenario tuned to trigger anomaly detection.
// Times are in Unix nanoseconds — all scenarios staggered 2h apart on 2026-03-09.
const SCENARIOS: Array<{
  label: string;
  diagnosis: DiagnosisResult;
  span: OtlpResourceSpans;
}> = [
  {
    label: "01 — rate-limit-cascade",
    diagnosis: d01,
    span: makeResourceSpans({
      serviceName: "web",
      environment: "production",
      traceId: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
      spanId: "seed_span_01",
      spanName: "POST /checkout",
      startNano: "1741485600000000000", // 2026-03-09T03:00:00Z
      durationMs: 5200,
      spanStatusCode: 2,
      httpRoute: "/checkout",
      httpStatusCode: 504,
    }),
  },
  {
    label: "02 — cascading-timeout",
    diagnosis: d02,
    span: makeResourceSpans({
      serviceName: "web",
      environment: "production",
      traceId: "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6",
      spanId: "seed_span_02",
      spanName: "POST /api/orders",
      startNano: "1741492800000000000", // 2026-03-09T05:00:00Z
      durationMs: 8200,
      spanStatusCode: 2,
      httpRoute: "/api/orders",
      httpStatusCode: 504,
    }),
  },
  {
    label: "03 — db-migration-lock",
    diagnosis: d03,
    span: makeResourceSpans({
      serviceName: "web",
      environment: "production",
      traceId: "e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      spanId: "seed_span_03",
      spanName: "GET /api/orders",
      startNano: "1741500000000000000", // 2026-03-09T07:00:00Z
      durationMs: 12000,
      spanStatusCode: 2,
      httpRoute: "/api/orders",
      httpStatusCode: 500,
    }),
  },
  {
    label: "04 — secrets-rotation",
    diagnosis: d04,
    span: makeResourceSpans({
      serviceName: "api-gateway",
      environment: "production",
      traceId: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5",
      spanId: "seed_span_04",
      spanName: "POST /api/payments",
      startNano: "1741507200000000000", // 2026-03-09T09:00:00Z
      durationMs: 1200,
      spanStatusCode: 2,
      httpRoute: "/api/payments",
      httpStatusCode: 401,
    }),
  },
  {
    label: "05 — cdn-cache-poison",
    diagnosis: d05,
    span: makeResourceSpans({
      serviceName: "cdn-edge",
      environment: "production",
      traceId: "d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1",
      spanId: "seed_span_05",
      spanName: "GET /products",
      startNano: "1741514400000000000", // 2026-03-09T11:00:00Z
      durationMs: 50,
      spanStatusCode: 2,
      httpRoute: "/products",
      httpStatusCode: 503,
    }),
  },
];

// --- OTLP shape helpers ---

interface OtlpResourceSpans {
  resourceSpans: Array<{
    resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
    scopeSpans: Array<{
      spans: Array<{
        traceId: string;
        spanId: string;
        name: string;
        startTimeUnixNano: string;
        endTimeUnixNano: string;
        status: { code: number };
        attributes: Array<{ key: string; value: { stringValue?: string; intValue?: number } }>;
      }>;
    }>;
  }>;
}

function makeResourceSpans(opts: {
  serviceName: string;
  environment: string;
  traceId: string;
  spanId: string;
  spanName: string;
  startNano: string;
  durationMs: number;
  spanStatusCode: number;
  httpRoute: string;
  httpStatusCode: number;
}): OtlpResourceSpans {
  const endNano = String(BigInt(opts.startNano) + BigInt(opts.durationMs) * 1_000_000n);
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: opts.serviceName } },
            {
              key: "deployment.environment.name",
              value: { stringValue: opts.environment },
            },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: opts.traceId,
                spanId: opts.spanId,
                name: opts.spanName,
                startTimeUnixNano: opts.startNano,
                endTimeUnixNano: endNano,
                status: { code: opts.spanStatusCode },
                attributes: [
                  {
                    key: "http.route",
                    value: { stringValue: opts.httpRoute },
                  },
                  {
                    key: "http.response.status_code",
                    value: { intValue: opts.httpStatusCode },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

// --- HTTP helpers ---

async function postJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${path} → ${res.status}: ${text}`);
  }
  return JSON.parse(text) as unknown;
}

// --- Seed ---

async function seed(): Promise<void> {
  console.log(`Seeding ${BASE_URL} with ${SCENARIOS.length} scenarios…`);

  for (const scenario of SCENARIOS) {
    process.stdout.write(`  ${scenario.label} … `);

    // Step 1: ingest anomalous span → Receiver creates incident + packet
    const ingestResp = (await postJson("/v1/traces", scenario.span)) as {
      status: string;
      incidentId: string;
      packetId: string;
    };

    if (ingestResp.status !== "ok" || !ingestResp.incidentId) {
      throw new Error(
        `Ingest failed for ${scenario.label}: ${JSON.stringify(ingestResp)}`,
      );
    }

    const { incidentId, packetId } = ingestResp;

    // Step 2: patch DiagnosisResult metadata to match live IDs, then POST
    const patchedDiagnosis: DiagnosisResult = {
      ...scenario.diagnosis,
      metadata: {
        ...scenario.diagnosis.metadata,
        incident_id: incidentId,
        packet_id: packetId,
      },
    };

    await postJson(`/api/diagnosis/${incidentId}`, patchedDiagnosis);

    console.log(`ok — incidentId=${incidentId}`);
  }

  console.log("Seed complete.");
}

seed().catch((err: unknown) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
