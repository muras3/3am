/**
 * diversity-fill.ts — Generic diversity-aware selection algorithm
 *
 * Extracted from packetizer.ts `selectRepresentativeTraces` to be reusable
 * for traces, metrics, and logs evidence selection.
 *
 * ## Algorithm
 *
 * Phase 1 — Top guarantee:
 *   Take up to `topGuarantee` items with score > 0 (highest-scored first).
 *   These are always included regardless of diversity key caps.
 *
 * Phase 2 — Diversity fill (greedy, dynamic service preference):
 *   Fill remaining budget preferring items from services not yet seen.
 *   A per-diversity-key cap prevents a single hot key from monopolising slots.
 *
 * Phase 3 — Fallback:
 *   If no unseen-service items remain, take best remaining within diversity caps.
 *
 * Items must be pre-sorted by score descending (with deterministic tiebreaking).
 */

export type DiversityFillOpts<T> = {
  /** Total selection budget */
  maxItems: number
  /** Number of top-scoring items guaranteed (not displaced by diversity caps) */
  topGuarantee: number
  /** Extract numeric score from an item */
  getScore: (item: T) => number
  /** Extract service key for service-level diversity preference */
  getServiceKey: (item: T) => string
  /** Extract diversity key for per-key cap (e.g., "service:route") */
  getDiversityKey: (item: T) => string
  /** Maximum items allowed per diversity key (in Phase 2/3 only) */
  maxPerDiversityKey: number
  /** Extract identity key for dedup / already-picked tracking */
  getIdentityKey: (item: T) => string
}

/**
 * Select items using the 3-phase diversity fill algorithm.
 *
 * @param sortedItems Items pre-sorted by score descending with deterministic tiebreaking
 * @param opts Configuration for the selection algorithm
 * @returns Selected items in [Phase 1 guaranteed, Phase 2/3 fill] order
 */
export function diversityFill<T>(
  sortedItems: T[],
  opts: DiversityFillOpts<T>,
): T[] {
  if (sortedItems.length === 0 || opts.maxItems <= 0) return []

  const {
    maxItems,
    topGuarantee,
    getScore,
    getServiceKey,
    getDiversityKey,
    maxPerDiversityKey,
    getIdentityKey,
  } = opts

  // ------------------------------------------------------------------
  // Phase 1 — Top guarantee
  // ------------------------------------------------------------------
  // Take up to `topGuarantee` items that have score > 0.
  // Dedup by identity key to prevent the same item being picked twice.
  const guaranteed: T[] = []
  const guaranteedIdentityKeys = new Set<string>()
  for (const item of sortedItems) {
    if (guaranteed.length >= topGuarantee) break
    if (getScore(item) > 0) {
      const idKey = getIdentityKey(item)
      if (guaranteedIdentityKeys.has(idKey)) continue
      guaranteed.push(item)
      guaranteedIdentityKeys.add(idKey)
    }
  }

  // Track diversity key caps and service set; seed with Phase 1 results.
  const diversityKeyCaps: Record<string, number> = {}
  const serviceSet = new Set<string>()

  for (const item of guaranteed) {
    const key = getDiversityKey(item)
    diversityKeyCaps[key] = (diversityKeyCaps[key] ?? 0) + 1
    serviceSet.add(getServiceKey(item))
  }

  // ------------------------------------------------------------------
  // Phase 2 + 3 — Diversity fill with fallback
  // ------------------------------------------------------------------
  // Phase 2: prefer items from services not yet seen in this phase.
  // Phase 3 (fallback): if no unseen-service item available, take best
  // remaining within diversity key caps.
  const guaranteedKeys = new Set(guaranteed.map(getIdentityKey))
  const remaining = sortedItems.filter((item) => !guaranteedKeys.has(getIdentityKey(item)))

  const fillPicks: T[] = []
  const phase2ServiceSet = new Set<string>()
  const phase2PickedKeys = new Set<string>()
  const budget = maxItems - guaranteed.length

  while (fillPicks.length < budget) {
    let picked: T | undefined

    // Pass 1 (Phase 2): prefer item from a service not yet seen
    for (const item of remaining) {
      if (phase2PickedKeys.has(getIdentityKey(item))) continue
      const divKey = getDiversityKey(item)
      if ((diversityKeyCaps[divKey] ?? 0) >= maxPerDiversityKey) continue
      if (!phase2ServiceSet.has(getServiceKey(item))) {
        picked = item
        break
      }
    }

    // Pass 2 (Phase 3 / fallback): no unseen-service available — take best remaining
    if (picked === undefined) {
      for (const item of remaining) {
        if (phase2PickedKeys.has(getIdentityKey(item))) continue
        const divKey = getDiversityKey(item)
        if ((diversityKeyCaps[divKey] ?? 0) >= maxPerDiversityKey) continue
        picked = item
        break
      }
    }

    if (picked === undefined) break

    fillPicks.push(picked)
    phase2PickedKeys.add(getIdentityKey(picked))
    const routeKey = getDiversityKey(picked)
    diversityKeyCaps[routeKey] = (diversityKeyCaps[routeKey] ?? 0) + 1
    phase2ServiceSet.add(getServiceKey(picked))
  }

  return [...guaranteed, ...fillPicks]
}
