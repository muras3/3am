/**
 * Runtime Map Engine — derives services, dependencies, edges, and summary from TelemetryStore spans.
 *
 * Serves GET /api/runtime-map. Reads from TelemetryStore (30min default window),
 * not SpanBuffer. Produces a response conforming to RuntimeMapResponseSchema.
 */

import { buildIncidentQueryFilter, type TelemetrySpan, type TelemetryStoreDriver, type TelemetryQueryFilter } from '../telemetry/interface.js'
import type { StorageDriver, Incident } from '../storage/interface.js'
import type { RuntimeMapResponse, RuntimeMapService, RuntimeMapRoute, RuntimeMapDependency, RuntimeMapServiceEdge, RuntimeMapIncident } from '@3amoncall/core/schemas/runtime-map'
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

function worstStatus(
  a: 'healthy' | 'degraded' | 'critical',
  b: 'healthy' | 'degraded' | 'critical',
): 'healthy' | 'degraded' | 'critical' {
  const rank = { healthy: 0, degraded: 1, critical: 2 } as const
  return rank[a] >= rank[b] ? a : b
}

// ── Span Kind constants ────────────────────────────────────────────────────

const SPAN_KIND_SERVER = 2
const SPAN_KIND_CLIENT = 3

// ── Internal accumulator types ─────────────────────────────────────────────

interface NodeAccumulator {
  id: string
  tier: 'entry_point' | 'runtime_unit' | 'dependency'
  label: string
  /** serviceName owning this node (undefined for dependency nodes) */
  serviceName: string | undefined
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
  serviceName: string | undefined
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
        serviceName: span.serviceName,
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
        serviceName: span.serviceName,
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
          serviceName: span.serviceName,
        },
        extraNodes: [
          {
            nodeId: depId,
            tier: 'dependency',
            label: normalizedPeer,
            serviceName: undefined,
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
      serviceName: span.serviceName,
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

  // ── Group nodes into services and dependencies ──

  // Collect dependency accumulators
  const depAccumulators = new Map<string, NodeAccumulator>()
  // Map serviceName → list of entry_point accumulators
  const serviceEntryPoints = new Map<string, NodeAccumulator[]>()
  // Map serviceName → all (entry_point + runtime_unit) accumulators for metric rollup
  const serviceAllNodes = new Map<string, NodeAccumulator[]>()

  for (const acc of nodeAccumulators.values()) {
    if (acc.tier === 'dependency') {
      depAccumulators.set(acc.id, acc)
    } else {
      const svcName = acc.serviceName ?? acc.id
      if (acc.tier === 'entry_point') {
        const list = serviceEntryPoints.get(svcName) ?? []
        list.push(acc)
        serviceEntryPoints.set(svcName, list)
      }
      const allList = serviceAllNodes.get(svcName) ?? []
      allList.push(acc)
      serviceAllNodes.set(svcName, allList)
    }
  }

  // ── Build services ──

  const services: RuntimeMapService[] = []
  for (const [svcName, allNodes] of serviceAllNodes) {
    const entryPoints = serviceEntryPoints.get(svcName) ?? []

    // Routes = entry_point nodes
    const routes: RuntimeMapRoute[] = entryPoints.map((acc) => {
      const errorRate = acc.totalSpans > 0 ? acc.errorSpans / acc.totalSpans : 0
      const reqPerSec = acc.totalSpans / windowSeconds
      return {
        id: acc.id,
        label: acc.label,
        status: computeStatus(errorRate),
        errorRate,
        reqPerSec,
      }
    })

    // Service metrics: rollup over all (entry_point + runtime_unit) nodes
    const totalSpans = allNodes.reduce((s, a) => s + a.totalSpans, 0)
    const errorSpans = allNodes.reduce((s, a) => s + a.errorSpans, 0)
    const allDurations = entryPoints.flatMap((a) => a.durations) // p95 from entry_points only
    const errorRate = totalSpans > 0 ? errorSpans / totalSpans : 0
    const p95Ms = computeP95(allDurations)
    const reqPerSec = (entryPoints.reduce((s, a) => s + a.totalSpans, 0)) / windowSeconds

    // Service status = worst child route status
    let serviceStatus: 'healthy' | 'degraded' | 'critical' = 'healthy'
    for (const route of routes) {
      serviceStatus = worstStatus(serviceStatus, route.status)
    }
    // If no routes, fall back to overall error rate
    if (routes.length === 0) {
      serviceStatus = computeStatus(errorRate)
    }

    services.push({
      serviceName: svcName,
      status: serviceStatus,
      routes,
      metrics: { errorRate, p95Ms, reqPerSec },
    })
  }

  // ── Build dependencies ──

  const dependencies: RuntimeMapDependency[] = []
  for (const acc of depAccumulators.values()) {
    const errorRate = acc.totalSpans > 0 ? acc.errorSpans / acc.totalSpans : 0
    const reqPerSec = acc.totalSpans / windowSeconds
    dependencies.push({
      id: acc.id,
      name: acc.label,
      status: computeStatus(errorRate),
      errorRate,
      reqPerSec,
    })
  }

  // ── Build service→dependency edges ──

  // For each edge in edgeAccumulators that goes from a non-dep node to a dep node,
  // resolve the service name of the source node.
  const serviceEdgesMap = new Map<string, RuntimeMapServiceEdge>()
  for (const acc of edgeAccumulators.values()) {
    const toAcc = nodeAccumulators.get(acc.toNodeId)
    if (toAcc?.tier !== 'dependency') continue

    // Resolve source service name
    const fromAcc = nodeAccumulators.get(acc.fromNodeId)
    const fromService = fromAcc?.serviceName ?? acc.fromNodeId
    const toDependency = toAcc.label

    const edgeKey = `${fromService}→${toDependency}`
    if (!serviceEdgesMap.has(edgeKey)) {
      const edgeErrorRate = acc.requestCount > 0 ? acc.errorCount / acc.requestCount : 0
      serviceEdgesMap.set(edgeKey, {
        fromService,
        toDependency,
        status: computeStatus(edgeErrorRate),
      })
    }
  }
  const edges: RuntimeMapServiceEdge[] = Array.from(serviceEdgesMap.values())

  // ── Match incidents ──

  const incidentRows: RuntimeMapIncident[] = []
  for (const incident of incidents) {
    incidentRows.push({
      incidentId: incident.incidentId,
      label: incident.consoleNarrative?.headline
        ?? incident.diagnosisResult?.summary.what_happened
        ?? incident.packet.scope.primaryService,
      severity: incident.packet.signalSeverity ?? 'medium',
      openedAgo: formatOpenedAgo(incident.openedAt),
    })

    assignIncidentToServiceModel(services, dependencies, incident)
  }

  // ── Summary ──

  const degradedServices = services.filter((s) => s.status !== 'healthy').length
  const clusterReqPerSec = services.reduce((sum, s) => sum + (s.metrics.reqPerSec ?? 0), 0)
  const clusterP95Ms = computeP95(allEntryPointDurations)

  return {
    summary: {
      activeIncidents: incidents.length,
      degradedServices,
      clusterReqPerSec,
      clusterP95Ms,
    },
    services,
    dependencies,
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
    label: incident.consoleNarrative?.headline
      ?? incident.diagnosisResult?.summary.what_happened
      ?? incident.packet.scope.primaryService,
    severity: incident.packet.signalSeverity ?? 'medium',
    openedAgo: formatOpenedAgo(incident.openedAt),
  }))

  const emptyReason = openIncidents.length > 0
    ? 'no_preserved_incident_spans'
    : 'no_open_incidents'

  return {
    summary: { activeIncidents: openIncidents.length, degradedServices: 0, clusterReqPerSec: 0, clusterP95Ms: 0 },
    services: [],
    dependencies: [],
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
      serviceName: derived.serviceName,
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

// ── Helper: assign incident to matching services/dependencies ──

function assignIncidentToServiceModel(
  services: RuntimeMapService[],
  dependencies: RuntimeMapDependency[],
  incident: Incident,
): void {
  const scope = incident.packet.scope

  for (const service of services) {
    if (service.incidentId) continue

    for (const route of service.routes) {
      if (route.incidentId) continue

      const routeMatch = scope.affectedRoutes.some((r) => route.id.includes(r.toLowerCase()))
      const serviceMatch = route.id.includes(`:${scope.primaryService}:`)
      if (routeMatch || serviceMatch) {
        route.incidentId = incident.incidentId
        service.incidentId = incident.incidentId
      }
    }

    // Also match by primaryService/affectedServices on the service level
    if (!service.incidentId) {
      const allServices = [scope.primaryService, ...scope.affectedServices]
      const svcMatch = allServices.some((s) => service.serviceName === s)
      if (svcMatch) {
        service.incidentId = incident.incidentId
      }
    }
  }

  for (const dep of dependencies) {
    if (dep.incidentId) continue

    const depMatch = scope.affectedDependencies.some((d) => dep.id === `dep:${d.toLowerCase()}`)
    if (depMatch) {
      dep.incidentId = incident.incidentId
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
