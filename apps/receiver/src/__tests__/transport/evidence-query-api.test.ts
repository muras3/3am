/**
 * evidence-query-api.test.ts — HTTP-level tests for POST /api/incidents/:id/evidence/query.
 *
 * Uses Hono test client (app.request) with MemoryAdapter, same pattern as chat.test.ts.
 * Anthropic SDK is mocked so no real API key is required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryAdapter } from '../../storage/adapters/memory.js'
import { createApp } from '../../index.js'
import { COOKIE_NAME } from '../../middleware/session-cookie.js'
import { EvidenceQueryResponseSchema } from '@3am/core/schemas/curated-evidence'
import type { DiagnosisResult } from '@3am/core'
import type * as DiagnosisModule from '@3am/diagnosis'

const { generateEvidencePlanMock, generateEvidenceQueryMock } = vi.hoisted(() => ({
  generateEvidencePlanMock: vi.fn(async (input: { question: string }) => ({
    mode: 'answer' as const,
    rewrittenQuestion: input.question,
    preferredSurfaces: ['traces', 'metrics', 'logs'] as const,
  })),
  generateEvidenceQueryMock: vi.fn(async (input: { question: string }, options?: { locale?: 'en' | 'ja' }) => ({
    question: input.question,
    status: 'answered' as const,
    segments: [
      {
        id: 'seg-1',
        kind: 'fact' as const,
        text: options?.locale === 'ja' ? '日本語の回答。' : 'English answer.',
        evidenceRefs: [{ kind: 'span' as const, id: 'abc_001:span_001' }],
      },
    ],
  })),
}))

vi.mock('@3am/diagnosis', async () => {
  const actual = await vi.importActual<typeof DiagnosisModule>('@3am/diagnosis')
  return {
    ...actual,
    generateEvidencePlan: generateEvidencePlanMock,
    generateEvidenceQuery: generateEvidenceQueryMock,
  }
})

// ── Helpers ────────────────────────────────────────────────────────────

const TOKEN = 'test-token'

function makeApp() {
  process.env['RECEIVER_AUTH_TOKEN'] = TOKEN
  return createApp(new MemoryAdapter())
}

function authHeader() {
  return { Authorization: `Bearer ${TOKEN}` }
}

function extractSessionCookie(res: Response): string {
  const header = res.headers.get('set-cookie') ?? ''
  const match = header.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))
  return match?.[1] ?? ''
}

async function getSessionCookie(app: ReturnType<typeof makeApp>): Promise<string> {
  const res = await app.request('/api/incidents', { headers: authHeader() })
  return extractSessionCookie(res)
}

function queryHeaders(sessionCookie: string) {
  return {
    ...authHeader(),
    'Content-Type': 'application/json',
    Cookie: `${COOKIE_NAME}=${sessionCookie}`,
  }
}

const minimalDiagnosis: DiagnosisResult = {
  summary: {
    what_happened: 'Rate limiter cascade caused 504s on /checkout.',
    root_cause_hypothesis: 'Stripe 429 leaked into checkout timeout budget.',
  },
  recommendation: {
    immediate_action: 'Disable Stripe retry loop.',
    action_rationale_short: 'Stops cascading 429s.',
    do_not: 'Do not increase timeout.',
  },
  reasoning: {
    causal_chain: [
      { type: 'external', title: 'Stripe 429', detail: 'Rate limited.' },
      { type: 'impact', title: 'Checkout 504', detail: 'Timed out.' },
    ],
  },
  operator_guidance: {
    watch_items: [],
    operator_checks: ['Confirm Stripe dashboard shows 429 spike.'],
  },
  confidence: {
    confidence_assessment: 'High',
    uncertainty: 'Unknown Stripe quota.',
  },
  metadata: {
    incident_id: '',
    packet_id: 'pkt_test',
    model: 'claude-haiku-4-5-20251001',
    prompt_version: 'v5',
    created_at: new Date().toISOString(),
  },
}

let seedCounter = 0

async function seedIncident(app: ReturnType<typeof makeApp>, withDiagnosis = false) {
  seedCounter++
  const suffix = String(seedCounter).padStart(3, '0')
  const ingestRes = await app.request('/v1/traces', {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: `web-${suffix}` } },
            { key: 'deployment.environment.name', value: { stringValue: 'production' } },
          ],
        },
        scopeSpans: [{
          spans: [{
            traceId: `abc_${suffix}`,
            spanId: `span_${suffix}`,
            name: 'POST /checkout',
            startTimeUnixNano: '1741392000000000000',
            endTimeUnixNano: '1741392005200000000',
            status: { code: 2 },
            attributes: [
              { key: 'http.route', value: { stringValue: '/checkout' } },
              { key: 'http.response.status_code', value: { intValue: 504 } },
            ],
          }],
        }],
      }],
    }),
  })
  const { incidentId } = (await ingestRes.json()) as { incidentId: string }

  if (withDiagnosis) {
    const dr: DiagnosisResult = {
      ...minimalDiagnosis,
      metadata: { ...minimalDiagnosis.metadata, incident_id: incidentId },
    }
    await app.request(`/api/diagnosis/${incidentId}`, {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(dr),
    })
  }

  return incidentId
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('POST /api/incidents/:id/evidence/query', () => {
  let app: ReturnType<typeof makeApp>

  beforeEach(() => {
    seedCounter = 0
    generateEvidenceQueryMock.mockClear()
    app = makeApp()
  })

  it('returns 200 with valid question', async () => {
    const cookie = await getSessionCookie(app)
    const incidentId = await seedIncident(app)

    const res = await app.request(`/api/incidents/${incidentId}/evidence/query`, {
      method: 'POST',
      headers: queryHeaders(cookie),
      body: JSON.stringify({ question: 'What happened?' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['question']).toBe('What happened?')
    expect(body['status']).toBeTruthy()
  })

  it('returns 400 when question is missing', async () => {
    const cookie = await getSessionCookie(app)
    const incidentId = await seedIncident(app)

    const res = await app.request(`/api/incidents/${incidentId}/evidence/query`, {
      method: 'POST',
      headers: queryHeaders(cookie),
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 when body is not JSON', async () => {
    const cookie = await getSessionCookie(app)
    const incidentId = await seedIncident(app)

    const res = await app.request(`/api/incidents/${incidentId}/evidence/query`, {
      method: 'POST',
      headers: {
        ...queryHeaders(cookie),
        'Content-Type': 'text/plain',
      },
      body: 'not json',
    })

    expect(res.status).toBe(400)
  })

  it('returns 404 when incident does not exist', async () => {
    const cookie = await getSessionCookie(app)

    const res = await app.request('/api/incidents/inc_nonexistent/evidence/query', {
      method: 'POST',
      headers: queryHeaders(cookie),
      body: JSON.stringify({ question: 'What happened?' }),
    })

    expect(res.status).toBe(404)
  })

  it('response matches EvidenceQueryResponseSchema', async () => {
    const cookie = await getSessionCookie(app)
    const incidentId = await seedIncident(app, true)

    const res = await app.request(`/api/incidents/${incidentId}/evidence/query`, {
      method: 'POST',
      headers: queryHeaders(cookie),
      body: JSON.stringify({ question: 'Why are payments failing?' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    const parsed = EvidenceQueryResponseSchema.strict().parse(body)
    expect(parsed.question).toBe('Why are payments failing?')
    expect(parsed.status).toBeTruthy()
    expect(Array.isArray(parsed.segments)).toBe(true)
    expect(parsed.evidenceSummary).toBeDefined()
    expect(parsed.followups).toBeDefined()
  })

  it('passes locale preference through to evidence query generation', async () => {
    const cookie = await getSessionCookie(app)
    const incidentId = await seedIncident(app, true)

    const settingsRes = await app.request('/api/settings/locale', {
      method: 'PUT',
      headers: queryHeaders(cookie),
      body: JSON.stringify({ locale: 'ja' }),
    })
    expect(settingsRes.status).toBe(200)

    const res = await app.request(`/api/incidents/${incidentId}/evidence/query`, {
      method: 'POST',
      headers: queryHeaders(cookie),
      body: JSON.stringify({ question: 'Why are payments failing?' }),
    })

    expect(res.status).toBe(200)
    expect(generateEvidenceQueryMock).toHaveBeenCalled()
    expect(generateEvidenceQueryMock.mock.calls[0]?.[0]).toMatchObject({
      question: 'Why are payments failing?',
    })
    expect(generateEvidenceQueryMock.mock.calls[0]?.[1]).toMatchObject({
      locale: 'ja',
    })
  })

  it('passes conversation history through to evidence query generation', async () => {
    const cookie = await getSessionCookie(app)
    const incidentId = await seedIncident(app, true)

    const res = await app.request(`/api/incidents/${incidentId}/evidence/query`, {
      method: 'POST',
      headers: queryHeaders(cookie),
      body: JSON.stringify({
        question: 'What next?',
        isFollowup: true,
        history: [
          { role: 'user', content: 'What is failing?' },
          { role: 'assistant', content: 'The checkout path is timing out.' },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(generateEvidenceQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'What next?',
        history: [
          { role: 'user', content: 'What is failing?' },
          { role: 'assistant', content: 'The checkout path is timing out.' },
        ],
      }),
      expect.any(Object),
    )
  })
})
