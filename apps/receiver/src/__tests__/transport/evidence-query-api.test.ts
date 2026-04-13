/**
 * evidence-query-api.test.ts — HTTP-level tests for POST /api/incidents/:id/evidence/query.
 *
 * Uses Hono test client (app.request) with MemoryAdapter, same pattern as chat.test.ts.
 * Anthropic SDK is mocked so no real API key is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryAdapter } from '../../storage/adapters/memory.js'
import { createApp } from '../../index.js'
import { BridgeJobQueue } from '../../runtime/bridge-job-queue.js'
import { COOKIE_NAME } from '../../middleware/session-cookie.js'
import { EvidenceQueryResponseSchema } from '3am-core/schemas/curated-evidence'
import type { DiagnosisResult } from '3am-core'
import type * as DiagnosisModule from '3am-diagnosis'

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

vi.mock('3am-diagnosis', async () => {
  const actual = await vi.importActual<typeof DiagnosisModule>('3am-diagnosis')
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
  const claimRes = await app.request('/api/claims', {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: '{}',
  })
  const claimBody = await claimRes.json() as { token: string }
  const exchangeRes = await app.request('/api/claims/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: claimBody.token }),
  })
  return extractSessionCookie(exchangeRes)
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
    const incidentId = await seedIncident(app, true)

    const res = await app.request(`/api/incidents/${incidentId}/evidence/query`, {
      method: 'POST',
      headers: queryHeaders(cookie),
      body: JSON.stringify({ question: 'What happened?' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['question']).toBe('What happened?')
    expect(body['status']).toBeTruthy()
    expect(generateEvidencePlanMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        allowSubprocessProviders: false,
        allowLocalHttpProviders: false,
      }),
    )
    expect(generateEvidenceQueryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        allowSubprocessProviders: false,
        allowLocalHttpProviders: false,
      }),
    )
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
    const parsed = EvidenceQueryResponseSchema.parse(body)
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

  it('uses locale from request body, overriding stored locale', async () => {
    const cookie = await getSessionCookie(app)
    const incidentId = await seedIncident(app, true)

    // Store locale as 'en' in settings
    const settingsRes = await app.request('/api/settings/locale', {
      method: 'PUT',
      headers: queryHeaders(cookie),
      body: JSON.stringify({ locale: 'en' }),
    })
    expect(settingsRes.status).toBe(200)

    // Send request with locale: 'ja' in the body — should override stored 'en'
    const res = await app.request(`/api/incidents/${incidentId}/evidence/query`, {
      method: 'POST',
      headers: queryHeaders(cookie),
      body: JSON.stringify({ question: 'Why are payments failing?', locale: 'ja' }),
    })

    expect(res.status).toBe(200)
    expect(generateEvidenceQueryMock).toHaveBeenCalled()
    expect(generateEvidenceQueryMock.mock.calls[0]?.[1]).toMatchObject({
      locale: 'ja',
    })
  })

  it('falls back to stored locale when request body has no locale', async () => {
    const cookie = await getSessionCookie(app)
    const incidentId = await seedIncident(app, true)

    // Store locale as 'ja' in settings
    const settingsRes = await app.request('/api/settings/locale', {
      method: 'PUT',
      headers: queryHeaders(cookie),
      body: JSON.stringify({ locale: 'ja' }),
    })
    expect(settingsRes.status).toBe(200)

    // Send request without locale in body — should fall back to stored 'ja'
    const res = await app.request(`/api/incidents/${incidentId}/evidence/query`, {
      method: 'POST',
      headers: queryHeaders(cookie),
      body: JSON.stringify({ question: 'Why are payments failing?' }),
    })

    expect(res.status).toBe(200)
    expect(generateEvidenceQueryMock).toHaveBeenCalled()
    expect(generateEvidenceQueryMock.mock.calls[0]?.[1]).toMatchObject({
      locale: 'ja',
    })
  })

  it('falls back to "en" when neither request body nor stored locale provides locale', async () => {
    const cookie = await getSessionCookie(app)
    const incidentId = await seedIncident(app, true)

    // No stored locale set (fresh app, default 'en')
    const res = await app.request(`/api/incidents/${incidentId}/evidence/query`, {
      method: 'POST',
      headers: queryHeaders(cookie),
      body: JSON.stringify({ question: 'Why are payments failing?' }),
    })

    expect(res.status).toBe(200)
    expect(generateEvidenceQueryMock).toHaveBeenCalled()
    expect(generateEvidenceQueryMock.mock.calls[0]?.[1]).toMatchObject({
      locale: 'en',
    })
  })

  it('rejects invalid locale values in request body', async () => {
    const cookie = await getSessionCookie(app)
    const incidentId = await seedIncident(app)

    const res = await app.request(`/api/incidents/${incidentId}/evidence/query`, {
      method: 'POST',
      headers: queryHeaders(cookie),
      body: JSON.stringify({ question: 'What happened?', locale: 'fr' }),
    })

    expect(res.status).toBe(400)
  })

  it('does not return clarification when isSystemFollowup is true', async () => {
    generateEvidencePlanMock.mockResolvedValueOnce({
      mode: 'clarification' as const,
      rewrittenQuestion: 'Which trace path first shows this failure within the incident window?',
      preferredSurfaces: ['traces'] as const,
      clarificationQuestion: 'Which failure do you mean?',
    })

    const cookie = await getSessionCookie(app)
    const incidentId = await seedIncident(app, true)

    const res = await app.request(`/api/incidents/${incidentId}/evidence/query`, {
      method: 'POST',
      headers: queryHeaders(cookie),
      body: JSON.stringify({
        question: '障害期間の中で、この失敗が最初に出たトレース経路はどれ？',
        isSystemFollowup: true,
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['status']).not.toBe('clarification')
  })

  it('returns clarification normally when isSystemFollowup is false or absent', async () => {
    generateEvidencePlanMock.mockResolvedValueOnce({
      mode: 'clarification' as const,
      rewrittenQuestion: 'Clarify which service you mean.',
      preferredSurfaces: ['traces'] as const,
      clarificationQuestion: 'Which service do you mean?',
    })

    const cookie = await getSessionCookie(app)
    const incidentId = await seedIncident(app, true)

    const res = await app.request(`/api/incidents/${incidentId}/evidence/query`, {
      method: 'POST',
      headers: queryHeaders(cookie),
      body: JSON.stringify({
        question: 'What is happening?',
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['status']).toBe('clarification')
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

  it('returns 503 for manual evidence query when a remote Vercel receiver is configured with a loopback bridge URL', async () => {
    await app.request('/api/settings/diagnosis', {
      method: 'PUT',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'manual',
        provider: 'codex',
        bridgeUrl: 'http://127.0.0.1:4269',
      }),
    })

    const originalFetch = globalThis.fetch
    const bridgeFetch = vi.fn()
    globalThis.fetch = bridgeFetch as typeof fetch

    const cookie = await getSessionCookie(app)
    const incidentId = await seedIncident(app, true)
    const res = await app.request(`https://receiver-example.vercel.app/api/incidents/${incidentId}/evidence/query`, {
      method: 'POST',
      headers: queryHeaders(cookie),
      body: JSON.stringify({ question: 'What happened?' }),
    })

    globalThis.fetch = originalFetch

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: 'manual evidence query bridge unavailable',
      details:
        'remote receiver https://receiver-example.vercel.app cannot reach loopback bridge URL http://127.0.0.1:4269. Vercel Functions do not expose the /bridge/ws upgrade path used by the local bridge client. Set LLM_BRIDGE_URL to a public bridge endpoint reachable from the receiver runtime, or switch manual mode to a supported relay runtime.',
    })
    expect(bridgeFetch).not.toHaveBeenCalled()
  })
})

// ── Vercel long-poll bridge job queue tests ───────────────────────────────

describe('POST /api/incidents/:id/evidence/query (bridgeJobQueue path)', () => {
  let app: ReturnType<typeof makeApp>
  let jobQueue: BridgeJobQueue

  function makeAppWithQueue() {
    process.env['RECEIVER_AUTH_TOKEN'] = TOKEN
    jobQueue = new BridgeJobQueue()
    return createApp(new MemoryAdapter(), { bridgeJobQueue: jobQueue })
  }

  beforeEach(() => {
    seedCounter = 0
    generateEvidenceQueryMock.mockClear()
    app = makeAppWithQueue()
  })

  afterEach(() => {
    jobQueue?.destroy()
  })

  it('routes manual evidence query through job queue when bridgeJobQueue is provided', async () => {
    // Set manual mode
    await app.request('/api/settings/diagnosis', {
      method: 'PUT',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'manual',
        provider: 'codex',
        bridgeUrl: 'http://127.0.0.1:4269',
      }),
    })

    const cookie = await getSessionCookie(app)
    const incidentId = await seedIncident(app, true)

    // Start the evidence query — it will enqueue and wait
    const queryPromise = app.request(
      `https://receiver-example.vercel.app/api/incidents/${incidentId}/evidence/query`,
      {
        method: 'POST',
        headers: queryHeaders(cookie),
        body: JSON.stringify({ question: 'What happened?' }),
      },
    )

    // Simulate bridge picking up the job
    await new Promise((r) => setTimeout(r, 10))
    const job = jobQueue.dequeue()
    expect(job).not.toBeNull()
    expect(job!.request.type).toBe('evidence_query_request')

    // Simulate bridge posting the result
    jobQueue.resolve(job!.jobId, {
      type: 'evidence_query_response',
      id: job!.jobId,
      result: {
        question: 'What happened?',
        status: 'answered',
        segments: [{ id: 'seg-1', kind: 'fact', text: 'Answer.', evidenceRefs: [] }],
      },
    })

    const res = await queryPromise
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['question']).toBe('What happened?')
    expect(body['status']).toBe('answered')
  })

  it('returns 502 when bridge resolves with error_response', async () => {
    await app.request('/api/settings/diagnosis', {
      method: 'PUT',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'manual',
        provider: 'codex',
        bridgeUrl: 'http://127.0.0.1:4269',
      }),
    })

    const cookie = await getSessionCookie(app)
    const incidentId = await seedIncident(app, true)

    const queryPromise = app.request(
      `https://receiver-example.vercel.app/api/incidents/${incidentId}/evidence/query`,
      {
        method: 'POST',
        headers: queryHeaders(cookie),
        body: JSON.stringify({ question: 'What happened?' }),
      },
    )

    await new Promise((r) => setTimeout(r, 10))
    const job = jobQueue.dequeue()
    expect(job).not.toBeNull()

    jobQueue.resolve(job!.jobId, {
      type: 'error_response',
      id: job!.jobId,
      error: 'LLM call failed',
    })

    const res = await queryPromise
    expect(res.status).toBe(502)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['error']).toBe('manual evidence query bridge failed')
    expect(body['details']).toBe('LLM call failed')
  })

  it('GET /api/bridge/jobs returns null when no pending jobs', async () => {
    const res = await app.request('/api/bridge/jobs', {
      method: 'GET',
      headers: authHeader(),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['job']).toBeNull()
  })

  it('GET /api/bridge/jobs returns a pending job', async () => {
    // Set manual mode and enqueue a job by triggering an evidence query
    await app.request('/api/settings/diagnosis', {
      method: 'PUT',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'manual',
        provider: 'codex',
        bridgeUrl: 'http://127.0.0.1:4269',
      }),
    })

    const cookie = await getSessionCookie(app)
    const incidentId = await seedIncident(app, true)

    // Trigger evidence query in background (it will hold)
    const queryPromise = app.request(
      `https://receiver-example.vercel.app/api/incidents/${incidentId}/evidence/query`,
      {
        method: 'POST',
        headers: queryHeaders(cookie),
        body: JSON.stringify({ question: 'What happened?' }),
      },
    )

    await new Promise((r) => setTimeout(r, 10))

    // Poll for jobs
    const jobRes = await app.request('/api/bridge/jobs', {
      method: 'GET',
      headers: authHeader(),
    })
    expect(jobRes.status).toBe(200)
    const jobBody = (await jobRes.json()) as { job: { jobId: string; request: { type: string } } }
    expect(jobBody.job).not.toBeNull()
    expect(jobBody.job.request.type).toBe('evidence_query_request')

    // Resolve so queryPromise doesn't hang
    jobQueue.resolve(jobBody.job.jobId, {
      type: 'evidence_query_response',
      id: jobBody.job.jobId,
      result: { question: 'What happened?', status: 'answered', segments: [] },
    })
    await queryPromise
  })

  it('POST /api/bridge/results/:jobId resolves the waiting job', async () => {
    await app.request('/api/settings/diagnosis', {
      method: 'PUT',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'manual',
        provider: 'codex',
        bridgeUrl: 'http://127.0.0.1:4269',
      }),
    })

    const cookie = await getSessionCookie(app)
    const incidentId = await seedIncident(app, true)

    const queryPromise = app.request(
      `https://receiver-example.vercel.app/api/incidents/${incidentId}/evidence/query`,
      {
        method: 'POST',
        headers: queryHeaders(cookie),
        body: JSON.stringify({ question: 'What happened?' }),
      },
    )

    await new Promise((r) => setTimeout(r, 10))

    // Get the job
    const jobRes = await app.request('/api/bridge/jobs', {
      method: 'GET',
      headers: authHeader(),
    })
    const jobBody = (await jobRes.json()) as { job: { jobId: string } }

    // Post result via the API endpoint
    const resultRes = await app.request(
      `/api/bridge/results/${jobBody.job.jobId}`,
      {
        method: 'POST',
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'evidence_query_response',
          id: jobBody.job.jobId,
          result: {
            question: 'What happened?',
            status: 'answered',
            segments: [{ id: 'seg-1', kind: 'fact', text: 'Resolved via API.', evidenceRefs: [] }],
          },
        }),
      },
    )
    expect(resultRes.status).toBe(200)

    // The evidence query should now resolve
    const res = await queryPromise
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['status']).toBe('answered')
  })

  it('POST /api/bridge/results/:jobId returns 404 for unknown job', async () => {
    const res = await app.request('/api/bridge/results/nonexistent', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'evidence_query_response',
        id: 'nonexistent',
        result: {},
      }),
    })
    expect(res.status).toBe(404)
  })

  it('POST /api/bridge/results/:jobId returns 400 for invalid body', async () => {
    const res = await app.request('/api/bridge/results/some-job', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})
