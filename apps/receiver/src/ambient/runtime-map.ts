/**
 * Runtime Map Engine — derives nodes, edges, and summary from TelemetryStore spans.
 *
 * Serves GET /api/runtime-map. Reads from TelemetryStore (30min default window),
 * not SpanBuffer. Produces a response conforming to RuntimeMapResponseSchema.
 */

import { buildIncidentQueryFilter, type TelemetrySpan, type TelemetryStoreDriver, type TelemetryQueryFilter } from '../telemetry/interface.js'
import type { StorageDriver, Incident } from '../storage/interface.js'
import type { RuntimeMapResponse, RuntimeMapNode, RuntimeMapEdge, RuntimeMapIncident } from '@3amoncall/core/schemas/runtime-map'
import { normalizeDependency } from '../domain/formation.js'

// ── Node ID normalization ──────────────────────────────────────────────────

/** Segments that look like IDs: 8+ hex/dash chars (UUIDs) or pure digits */
const ID_SEGMENT_PATTERN = /^[0-9a-f-]{8,}$|^\d+$/

/**
 * Normalize an HTTP route to a canonical form.
 * - Path params replaced with `:id`
 * - Trailing slash removed
 * - Lowercased
 */
export function normalizeRoute(method: string | undefined, route: string): string {
  const segments = route.split('/')
  const normalized = segments.map((seg) =>
    ID_SEGMENT_PATTERN.test(seg) ? ':id' : seg,
  )
  let result = normalized.join('/')
  // Remove trailing slash (but keep "/" itself)
  if (result.length > 1 && result.endsWith('/')) {
    result = result.slice(0, -1)
  }
  return result.toLowerCase()
}

/**
 * Normalize a span name for node ID construction.
 * - Remove method prefix ("GET ", "POST " etc.)
 * - Replace UUID/numeric segments with `:id`
 * - Lowercase
 */
export function normalizeSpanName(spanName: string): string {
  // Remove leading HTTP method prefix (e.g. "GET /foo" → "/foo")
  const withoutMethod = spanName.replace(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i, '')
  // Replace ID-like segments
  const segments = withoutMethod.split('/')
  const normalized = segments.map((seg) =>
    ID_SEGMENT_PATTERN.test(seg) ? ':id' : seg,
  )
  return normalized.join('/').toLowerCase()
}

/**
 * Normalize a peer.service value.
 * Reuses the normalizeDependency logic from formation.ts (loopback/IP removal, lowercase).
 * Returns undefined for ignored values.
 */
export function normalizePeerService(raw: string | undefined): string | undefined {
  return normalizeDependency(raw)
}

// ── Error detection ────────────────────────────────────────────────────────

function isSpanError(span: TelemetrySpan): boolean {
  if (span.httpStatusCode !== undefined && span.httpStatusCode >= 500) return true
  if (span.httpStatusCode === 429) return true
  if (span.spanStatusCode === 2) return true
  if (span.exceptionCount > 0) return true
  return false
}

// ── P95 calculation ────────────────────────────────────────────────────────

function computeP95(durations: number[]): number {
  if (durations.length === 0) return 0
  const sorted = [...durations].sort((a, b) => a - b)
  const idx = Math.ceil(sorted.length * 0.95) - 1
  return sorted[Math.max(0, idx)] ?? 0
}

// ── Node status ────────────────────────────────────────────────────────────

function computeStatus(errorRate: number): 'healthy' | 'degraded' | 'critical' {
  if (errorRate >= 0.05) return 'critical'
  if (errorRate >= 0.01) return 'degraded'
  return 'healthy'
}

// ── Span Kind constants ────────────────────────────────────────────────────

const SPAN_KIND_SERVER = 2
const SPAN_KIND_CLIENT = 3

// ── Internal accumulator types ─────────────────────────────────────────────

interface NodeAccumulator {
  id: string
  tier: 'entry_point' | 'runtime_unit' | 'dependency'
  label: string
  totalSpans: number
  errorSpans: number
  durations: number[]
}

interface EdgeAccumulator {
  fromNodeId: string
  toNodeId: string
  kind: 'internal' | 'external'
  requestCount: number
  errorCount: number
}

// ── Node derivation from a single span ─────────────────────────────────────

interface DerivedNode {
  nodeId: string
  tier: 'entry_point' | 'runtime_unit' | 'dependency'
  label: string
}

interface DerivedEdge {
  fromNodeId: string
  toNodeId: string
  kind: 'internal' | 'external'
}

interface SpanDerivation {
  /** The primary node this span belongs to */
  primaryNode: DerivedNode
  /** Additional nodes (e.g., dependency node from CLIENT span) */
  extraNodes: DerivedNode[]
  /** Edges derived directly from this span's semantics (e.g., unit→dep for CLIENT spans) */
  directEdges: DerivedEdge[]
}

function deriveFromSpan(span: TelemetrySpan): SpanDerivation {
  const spanKind = span.spanKind

  // SERVER span with httpRoute → entry_point
  if (spanKind === SPAN_KIND_SERVER && span.httpRoute) {
    const normalizedRoute = normalizeRoute(span.httpMethod, span.httpRoute)
    const method = (span.httpMethod ?? 'GET').toUpperCase()
    const nodeId = `route:${span.serviceName}:${method}:${normalizedRoute}`
    return {
      primaryNode: {
        nodeId,
        tier: 'entry_point',
        label: `${method} ${normalizedRoute}`,
      },
      extraNodes: [],
      directEdges: [],
    }
  }

  // SERVER span without httpRoute — fallback: use spanName if it looks like a route
  if (spanKind === SPAN_KIND_SERVER && !span.httpRoute && span.spanName) {
    const normalizedName = normalizeSpanName(span.spanName)
    const nodeId = `route:${span.serviceName}:${normalizedName}`
    return {
      primaryNode: {
        nodeId,
        tier: 'entry_point',
        label: normalizedName,
      },
      extraNodes: [],
      directEdges: [],
    }
  }

  // CLIENT span with peerService → runtime_unit + dependency
  if (spanKind === SPAN_KIND_CLIENT && span.peerService) {
    const normalizedPeer = normalizePeerService(span.peerService)
    if (normalizedPeer) {
      const normalizedName = normalizeSpanName(span.spanName)
      const unitId = `unit:${span.serviceName}:${normalizedName}`
      const depId = `dep:${normalizedPeer}`
      return {
        primaryNode: {
          nodeId: unitId,
          tier: 'runtime_unit',
          label: normalizedName,
        },
        extraNodes: [
          {
            nodeId: depId,
            tier: 'dependency',
            label: normalizedPeer,
          },
        ],
        directEdges: [
          {
            fromNodeId: unitId,
            toNodeId: depId,
            kind: 'external',
          },
        ],
      }
    }
  }

  // INTERNAL or other → runtime_unit
  const normalizedName = normalizeSpanName(span.spanName)
  const nodeId = `unit:${span.serviceName}:${normalizedName}`
  return {
    primaryNode: {
      nodeId,
      tier: 'runtime_unit',
      label: normalizedName,
    },
    extraNodes: [],
    directEdges: [],
  }
}

// ── Main build function ────────────────────────────────────────────────────

const DEFAULT_WINDOW_MINUTES = 30

export async function buildRuntimeMap(
  telemetryStore: TelemetryStoreDriver,
  storage: StorageDriver,
  windowMinutes?: number,
): Promise<RuntimeMapResponse> {
  const minutes = windowMinutes ?? DEFAULT_WINDOW_MINUTES
  const now = Date.now()
  const startMs = now - minutes * 60 * 1000
  const endMs = now

  const filter: TelemetryQueryFilter = { startMs, endMs }
  const spans = await telemetryStore.querySpans(filter)
  const incidentPage = await storage.listIncidents({ limit: 100 })
  const openIncidents = incidentPage.items
    .filter((i) => i.status === 'open')
    .sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime())

  // Live window empty: fall back to the newest open incident with preserved spans.
  if (spans.length === 0) {
    const fallback = await findIncidentFallback(openIncidents, telemetryStore)
    if (fallback !== null) {
      return assembleRuntimeMap({
        spans: fallback.spans,
        incidents: openIncidents,
        source: 'incident_scope',
        windowLabel: `captured incident window · ${formatShortIncidentId(fallback.incident.incidentId)}`,
        scopeIncidentId: fallback.incident.incidentId,
      })
    }

    return emptyRuntimeMap(openIncidents, minutes)
  }

  return assembleRuntimeMap({
    spans,
    incidents: openIncidents,
    source: 'recent_window',
    windowLabel: `last ${minutes}m`,
  })
}

function assembleRuntimeMap(input: {
  spans: TelemetrySpan[]
  incidents: Incident[]
  source: 'recent_window' | 'incident_scope'
  windowLabel: string
  scopeIncidentId?: string
}): RuntimeMapResponse {
  const { spans, incidents, source, windowLabel, scopeIncidentId } = input
  const windowSeconds = computeWindowSeconds(spans)

  // ── Derive nodes and edges from spans ──

  const nodeAccumulators = new Map<string, NodeAccumulator>()
  const spanToNodeId = new Map<string, string>() // spanId → primary nodeId
  const edgeAccumulators = new Map<string, EdgeAccumulator>() // "from→to" key
  const allEntryPointDurations: number[] = []

  for (const span of spans) {
    const derivation = deriveFromSpan(span)
    const isError = isSpanError(span)

    // Record span → node mapping for parent-child edge resolution
    spanToNodeId.set(span.spanId, derivation.primaryNode.nodeId)

    // Accumulate primary node
    accumulateNode(nodeAccumulators, derivation.primaryNode, span.durationMs, isError)

    // Accumulate extra nodes (dependency nodes don't get span metrics directly)
    for (const extra of derivation.extraNodes) {
      accumulateNode(nodeAccumulators, extra, span.durationMs, isError)
    }

    // Accumulate direct edges (e.g., unit→dep for CLIENT spans)
    for (const edge of derivation.directEdges) {
      accumulateEdge(edgeAccumulators, edge.fromNodeId, edge.toNodeId, edge.kind, isError)
    }

    // Track entry_point durations for summary p95
    if (derivation.primaryNode.tier === 'entry_point') {
      allEntryPointDurations.push(span.durationMs)
    }
  }

  // ── Build parent-child edges ──

  for (const span of spans) {
    if (!span.parentSpanId) continue
    const parentNodeId = spanToNodeId.get(span.parentSpanId)
    if (!parentNodeId) continue
    const childNodeId = spanToNodeId.get(span.spanId)
    if (!childNodeId) continue
    if (parentNodeId === childNodeId) continue // skip self-loops

    const toNode = nodeAccumulators.get(childNodeId)
    const kind: 'internal' | 'external' = toNode?.tier === 'dependency' ? 'external' : 'internal'
    accumulateEdge(edgeAccumulators, parentNodeId, childNodeId, kind, isSpanError(span))
  }

  // ── Finalize nodes ──

  const nodes: RuntimeMapNode[] = []
  for (const acc of nodeAccumulators.values()) {
    const errorRate = acc.totalSpans > 0 ? acc.errorSpans / acc.totalSpans : 0
    const p95Ms = computeP95(acc.durations)
    const reqPerSec = acc.totalSpans / windowSeconds
    const status = computeStatus(errorRate)

    const subtitle = acc.tier === 'entry_point'
      ? `${reqPerSec.toFixed(1)} req/s`
      : acc.tier === 'dependency'
        ? 'external'
        : `${reqPerSec.toFixed(1)} req/s`

    nodes.push({
      id: acc.id,
      tier: acc.tier,
      label: acc.label,
      subtitle,
      status,
      metrics: { errorRate, p95Ms, reqPerSec },
      badges: errorRate > 0 ? [`${Math.round(errorRate * 100)}% err`] : [],
    })
  }

  // ── Finalize edges ──

  const edges: RuntimeMapEdge[] = []
  for (const acc of edgeAccumulators.values()) {
    edges.push({
      fromNodeId: acc.fromNodeId,
      toNodeId: acc.toNodeId,
      kind: acc.kind,
      status: computeStatus(acc.requestCount > 0 ? acc.errorCount / acc.requestCount : 0),
      trafficHint: `${acc.requestCount}`,
    })
  }

  // ── Match incidents ──

  const incidentRows: RuntimeMapIncident[] = []
  for (const incident of incidents) {
    incidentRows.push({
      incidentId: incident.incidentId,
      label: incident.diagnosisResult?.summary.what_happened
        ?? incident.packet.scope.primaryService,
      severity: incident.packet.signalSeverity ?? 'medium',
      openedAgo: formatOpenedAgo(incident.openedAt),
    })

    assignIncidentToNodes(nodes, incident)
  }

  // ── Summary ──

  const entryPointNodes = nodes.filter((n) => n.tier === 'entry_point')
  const degradedNodes = nodes.filter((n) => n.status !== 'healthy').length
  const clusterReqPerSec = entryPointNodes.reduce((sum, n) => sum + (n.metrics.reqPerSec ?? 0), 0)
  const clusterP95Ms = computeP95(allEntryPointDurations)

  return {
    summary: {
      activeIncidents: incidents.length,
      degradedNodes,
      clusterReqPerSec,
      clusterP95Ms,
    },
    nodes,
    edges,
    incidents: incidentRows,
    state: {
      diagnosis: 'ready',
      source,
      windowLabel,
      ...(source === 'incident_scope' && scopeIncidentId ? { scopeIncidentId } : {}),
    },
  }
}

async function findIncidentFallback(
  incidents: Incident[],
  telemetryStore: TelemetryStoreDriver,
): Promise<{ incident: Incident; spans: TelemetrySpan[] } | null> {
  for (const incident of incidents) {
    if (incident.telemetryScope.windowStartMs >= incident.telemetryScope.windowEndMs) continue

    const scopedSpans = await telemetryStore.querySpans(buildIncidentQueryFilter(incident.telemetryScope))
    const membership = new Set(incident.spanMembership)
    const spans = membership.size > 0
      ? scopedSpans.filter((span) => membership.has(`${span.traceId}:${span.spanId}`))
      : scopedSpans

    if (spans.length > 0) {
      return { incident, spans }
    }
  }

  return null
}

function emptyRuntimeMap(openIncidents: Incident[], windowMinutes: number): RuntimeMapResponse {
  const incidentRows = openIncidents.map((incident) => ({
    incidentId: incident.incidentId,
    label: incident.diagnosisResult?.summary.what_happened
      ?? incident.packet.scope.primaryService,
    severity: incident.packet.signalSeverity ?? 'medium',
    openedAgo: formatOpenedAgo(incident.openedAt),
  }))

  const emptyReason = openIncidents.length > 0
    ? 'no_preserved_incident_spans'
    : 'no_open_incidents'

  return {
    summary: { activeIncidents: openIncidents.length, degradedNodes: 0, clusterReqPerSec: 0, clusterP95Ms: 0 },
    nodes: [],
    edges: [],
    incidents: incidentRows,
    state: {
      diagnosis: 'ready',
      source: 'no_telemetry',
      windowLabel: `last ${windowMinutes}m`,
      emptyReason,
    },
  }
}

function computeWindowSeconds(spans: TelemetrySpan[]): number {
  if (spans.length < 2) return DEFAULT_WINDOW_MINUTES * 60
  const startTimes = spans.map((span) => span.startTimeMs)
  const min = Math.min(...startTimes)
  const max = Math.max(...startTimes)
  return Math.max(60, (max - min) / 1000)
}

// ── Helper: accumulate a node ──

function accumulateNode(
  map: Map<string, NodeAccumulator>,
  derived: DerivedNode,
  durationMs: number,
  isError: boolean,
): void {
  const existing = map.get(derived.nodeId)
  if (existing) {
    existing.totalSpans++
    if (isError) existing.errorSpans++
    existing.durations.push(durationMs)
  } else {
    map.set(derived.nodeId, {
      id: derived.nodeId,
      tier: derived.tier,
      label: derived.label,
      totalSpans: 1,
      errorSpans: isError ? 1 : 0,
      durations: [durationMs],
    })
  }
}

// ── Helper: accumulate an edge ──

function accumulateEdge(
  map: Map<string, EdgeAccumulator>,
  fromNodeId: string,
  toNodeId: string,
  kind: 'internal' | 'external',
  isError: boolean,
): void {
  const key = `${fromNodeId}→${toNodeId}`
  const existing = map.get(key)
  if (existing) {
    existing.requestCount++
    if (isError) existing.errorCount++
    // Escalate kind to "external" if any contributing edge is external
    if (kind === 'external') existing.kind = 'external'
  } else {
    map.set(key, {
      fromNodeId,
      toNodeId,
      kind,
      requestCount: 1,
      errorCount: isError ? 1 : 0,
    })
  }
}

// ── Helper: assign incident to matching nodes ──

function assignIncidentToNodes(nodes: RuntimeMapNode[], incident: Incident): void {
  const scope = incident.packet.scope

  for (const node of nodes) {
    if (node.incidentId) continue // already assigned

    if (node.tier === 'entry_point') {
      // Match by affectedRoutes or primaryService
      const routeMatch = scope.affectedRoutes.some((r) => node.id.includes(r.toLowerCase()))
      const serviceMatch = node.id.includes(`:${scope.primaryService}:`)
      if (routeMatch || serviceMatch) {
        node.incidentId = incident.incidentId
      }
    } else if (node.tier === 'dependency') {
      // Match by affectedDependencies
      const depMatch = scope.affectedDependencies.some((d) => node.id === `dep:${d.toLowerCase()}`)
      if (depMatch) {
        node.incidentId = incident.incidentId
      }
    } else {
      // runtime_unit: match by primaryService or affectedServices
      const allServices = [scope.primaryService, ...scope.affectedServices]
      const serviceMatch = allServices.some((s) => node.id.startsWith(`unit:${s}:`))
      if (serviceMatch) {
        node.incidentId = incident.incidentId
      }
    }
  }
}

function formatOpenedAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffMin = Math.max(0, Math.floor(diffMs / 60_000))
  if (diffMin < 60) return `${diffMin}m`
  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return `${diffHours}h`
  return `${Math.floor(diffHours / 24)}d`
}

function formatShortIncidentId(incidentId: string): string {
  return incidentId.replace(/^inc[_-]?/i, '').slice(0, 4).toUpperCase()
}
