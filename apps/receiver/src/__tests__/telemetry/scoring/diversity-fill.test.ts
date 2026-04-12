import { describe, it, expect } from "vitest"
import { diversityFill, type DiversityFillOpts } from "../../../telemetry/scoring/diversity-fill.js"

// ---------------------------------------------------------------------------
// Test helper types
// ---------------------------------------------------------------------------

type TestItem = {
  id: string
  score: number
  service: string
  route: string
}

function makeItem(overrides: Partial<TestItem> & { id: string }): TestItem {
  return {
    id: overrides.id,
    score: overrides.score ?? 0,
    service: overrides.service ?? "svc-A",
    route: overrides.route ?? "/default",
  }
}

/** Pre-sort items by score descending, then id ascending (deterministic tiebreak) */
function preSorted(items: TestItem[]): TestItem[] {
  return items.slice().sort((a, b) => {
    const scoreDiff = b.score - a.score
    if (scoreDiff !== 0) return scoreDiff
    return a.id.localeCompare(b.id)
  })
}

const defaultOpts: DiversityFillOpts<TestItem> = {
  maxItems: 10,
  topGuarantee: 3,
  getScore: (item) => item.score,
  getServiceKey: (item) => item.service,
  getDiversityKey: (item) => `${item.service}:${item.route}`,
  maxPerDiversityKey: 3,
  getIdentityKey: (item) => item.id,
}

function fill(items: TestItem[], opts?: Partial<DiversityFillOpts<TestItem>>): TestItem[] {
  return diversityFill(preSorted(items), { ...defaultOpts, ...opts })
}

// =============================================================================
// Phase 1: Top guarantee
// =============================================================================

describe("Phase 1: top guarantee", () => {
  it("selects up to topGuarantee items with score > 0", () => {
    const items = [
      makeItem({ id: "a1", score: 10, service: "svc-A" }),
      makeItem({ id: "a2", score: 8, service: "svc-A" }),
      makeItem({ id: "a3", score: 5, service: "svc-A" }),
      makeItem({ id: "a4", score: 3, service: "svc-A" }),
      makeItem({ id: "a5", score: 0, service: "svc-A" }),
    ]
    const result = fill(items, { topGuarantee: 3, maxItems: 3 })

    // Should pick the top 3 scored items
    expect(result.map((r) => r.id)).toEqual(["a1", "a2", "a3"])
  })

  it("fewer items with score > 0 than topGuarantee → takes only those", () => {
    const items = [
      makeItem({ id: "a1", score: 5, service: "svc-A" }),
      makeItem({ id: "a2", score: 0, service: "svc-A" }),
      makeItem({ id: "a3", score: 0, service: "svc-A" }),
    ]
    const result = fill(items, { topGuarantee: 3, maxItems: 5 })

    // Phase 1 gets only 1, Phase 2/3 fills the rest
    const guaranteed = result.filter((r) => r.score > 0)
    expect(guaranteed).toHaveLength(1)
    expect(guaranteed[0]!.id).toBe("a1")
  })

  it("guaranteed items are not subject to diversity key caps", () => {
    // All 3 guaranteed items on the same diversity key — they should all be included
    const items = [
      makeItem({ id: "h1", score: 10, service: "svc-A", route: "/hot" }),
      makeItem({ id: "h2", score: 9, service: "svc-A", route: "/hot" }),
      makeItem({ id: "h3", score: 8, service: "svc-A", route: "/hot" }),
      makeItem({ id: "h4", score: 7, service: "svc-A", route: "/hot" }),
      makeItem({ id: "o1", score: 0, service: "svc-B", route: "/other" }),
    ]
    const result = fill(items, { topGuarantee: 3, maxPerDiversityKey: 2 })

    // All 3 guaranteed despite maxPerDiversityKey=2
    const guaranteedIds = result.slice(0, 3).map((r) => r.id)
    expect(guaranteedIds).toEqual(["h1", "h2", "h3"])
  })

  it("no items with score > 0 → Phase 1 empty, Phase 2/3 fill from score=0", () => {
    const items = [
      makeItem({ id: "z1", score: 0, service: "svc-A" }),
      makeItem({ id: "z2", score: 0, service: "svc-B" }),
      makeItem({ id: "z3", score: 0, service: "svc-C" }),
    ]
    const result = fill(items, { topGuarantee: 3, maxItems: 5 })

    // All items available, but none in Phase 1
    expect(result).toHaveLength(3)
  })
})

// =============================================================================
// Phase 2: Service diversity
// =============================================================================

describe("Phase 2: service diversity", () => {
  it("prefers items from unseen services over same-service items", () => {
    // Phase 2 maintains its own service set separate from Phase 1.
    // Both svc-A and svc-B are "unseen" in Phase 2, so score order wins first.
    // After svc-A appears in Phase 2, svc-B and svc-C become preferred.
    const items = [
      // Phase 1 picks a1 (highest score)
      makeItem({ id: "a1", score: 10, service: "svc-A", route: "/api" }),
      // Phase 2: a2 (svc-A, score=5) picked first (unseen in Phase 2, higher score)
      makeItem({ id: "a2", score: 5, service: "svc-A", route: "/api2" }),
      // Then b1 (unseen svc-B in Phase 2)
      makeItem({ id: "b1", score: 4, service: "svc-B", route: "/api" }),
      // Then c1 (unseen svc-C in Phase 2)
      makeItem({ id: "c1", score: 3, service: "svc-C", route: "/api" }),
    ]
    const result = fill(items, { topGuarantee: 1, maxItems: 4 })

    // Phase 1: a1. Phase 2: a2 first (both svc-A and svc-B unseen, a2 higher score),
    // then b1 (unseen svc-B), then c1 (unseen svc-C)
    expect(result.map((r) => r.id)).toEqual(["a1", "a2", "b1", "c1"])
  })

  it("Phase 2 prefers unseen service when scores are equal", () => {
    const items = [
      // Phase 1 picks a1 (highest score)
      makeItem({ id: "a1", score: 10, service: "svc-A", route: "/api" }),
      // Phase 2: same score — svc-A already seen after first pick, so svc-B preferred
      makeItem({ id: "a2", score: 5, service: "svc-A", route: "/api2" }),
      makeItem({ id: "b1", score: 5, service: "svc-B", route: "/api" }),
    ]
    const result = fill(items, { topGuarantee: 1, maxItems: 3 })

    // Phase 1: a1. Phase 2: a2 picked first (both unseen, a2 sorted first by id),
    // then b1 (unseen svc-B)
    expect(result[0]!.id).toBe("a1")
    // a2 comes before b1 in score-sorted order (same score, "a2" < "b1")
    expect(result[1]!.id).toBe("a2")
    expect(result[2]!.id).toBe("b1")
  })

  it("dynamic preference: once a service appears in Phase 2, next iteration prefers new services", () => {
    const items = [
      makeItem({ id: "a1", score: 10, service: "svc-A", route: "/r1" }),
      makeItem({ id: "b1", score: 5, service: "svc-B", route: "/r1" }),
      makeItem({ id: "c1", score: 4, service: "svc-C", route: "/r1" }),
      makeItem({ id: "b2", score: 3, service: "svc-B", route: "/r2" }),
      makeItem({ id: "d1", score: 2, service: "svc-D", route: "/r1" }),
    ]
    const result = fill(items, { topGuarantee: 1, maxItems: 5 })

    // Phase 1: a1. Phase 2: b1 (new), c1 (new), d1 (new), b2 (seen but next best)
    const ids = result.map((r) => r.id)
    expect(ids[0]).toBe("a1")
    expect(ids[1]).toBe("b1")
    expect(ids[2]).toBe("c1")
    expect(ids[3]).toBe("d1")
    expect(ids[4]).toBe("b2")
  })

  it("upstream service with 1 span is selected among 20 downstream spans", () => {
    const upstream = makeItem({ id: "up1", score: 5, service: "upstream-svc", route: "/api" })
    const downstream = Array.from({ length: 20 }, (_, i) =>
      makeItem({ id: `ds-${i}`, score: 5, service: "downstream-svc", route: "/api/downstream" }),
    )
    const result = fill([upstream, ...downstream], { topGuarantee: 3, maxItems: 10 })

    expect(result.some((r) => r.id === "up1")).toBe(true)
  })
})

// =============================================================================
// Per-diversity-key cap
// =============================================================================

describe("per-diversity-key cap", () => {
  it("caps items per diversity key in Phase 2/3", () => {
    const items = [
      // Phase 1 takes 0 (all score=0)
      ...Array.from({ length: 20 }, (_, i) =>
        makeItem({ id: `hot-${i}`, score: 0, service: "svc-A", route: "/hot" }),
      ),
    ]
    const result = fill(items, { maxItems: 10, topGuarantee: 3, maxPerDiversityKey: 3 })

    // Only 3 from the same diversity key (svc-A:/hot)
    expect(result).toHaveLength(3)
  })

  it("Phase 1 items count toward diversity key caps for Phase 2", () => {
    // Phase 1 already has 3 items on svc-A:/hot (fills the cap)
    const items = [
      makeItem({ id: "h1", score: 10, service: "svc-A", route: "/hot" }),
      makeItem({ id: "h2", score: 9, service: "svc-A", route: "/hot" }),
      makeItem({ id: "h3", score: 8, service: "svc-A", route: "/hot" }),
      // These should be blocked by the diversity cap
      makeItem({ id: "h4", score: 7, service: "svc-A", route: "/hot" }),
      makeItem({ id: "h5", score: 6, service: "svc-A", route: "/hot" }),
      // This is on a different key — should be picked
      makeItem({ id: "b1", score: 1, service: "svc-B", route: "/other" }),
    ]
    const result = fill(items, { topGuarantee: 3, maxPerDiversityKey: 3 })

    // h1, h2, h3 (Phase 1), then b1 (Phase 2 — different key, since svc-A:/hot is capped)
    const ids = result.map((r) => r.id)
    expect(ids).toContain("h1")
    expect(ids).toContain("h2")
    expect(ids).toContain("h3")
    expect(ids).toContain("b1")
    // h4 and h5 blocked
    expect(ids).not.toContain("h4")
    expect(ids).not.toContain("h5")
  })

  it("remaining budget after cap is filled by items from other keys", () => {
    const items = [
      // 5 items on hot key (score > 0)
      ...Array.from({ length: 5 }, (_, i) =>
        makeItem({ id: `hot-${i}`, score: 5, service: "svc-A", route: "/hot" }),
      ),
      // 5 items on another key
      ...Array.from({ length: 5 }, (_, i) =>
        makeItem({ id: `alt-${i}`, score: 4, service: "svc-B", route: "/alt" }),
      ),
    ]
    const result = fill(items, { topGuarantee: 3, maxItems: 8, maxPerDiversityKey: 3 })

    const altCount = result.filter((r) => r.id.startsWith("alt-")).length
    expect(altCount).toBeGreaterThanOrEqual(1)
  })
})

// =============================================================================
// Phase 3: Fallback
// =============================================================================

describe("Phase 3: fallback", () => {
  it("when all services already seen, fills from best remaining within diversity caps", () => {
    const items = [
      makeItem({ id: "a1", score: 10, service: "svc-A", route: "/r1" }),
      makeItem({ id: "a2", score: 5, service: "svc-A", route: "/r2" }),
      makeItem({ id: "a3", score: 3, service: "svc-A", route: "/r3" }),
    ]
    const result = fill(items, { topGuarantee: 1, maxItems: 5 })

    // Phase 1 picks a1. Phase 2 tries unseen services — none.
    // Fallback: picks a2, a3 (all on svc-A but different diversity keys)
    expect(result).toHaveLength(3)
    expect(result.map((r) => r.id)).toEqual(["a1", "a2", "a3"])
  })

  it("stops when all remaining items hit diversity key cap", () => {
    const items = [
      makeItem({ id: "a1", score: 10, service: "svc-A", route: "/r1" }),
      // All remaining are on the same key as a1
      makeItem({ id: "a2", score: 5, service: "svc-A", route: "/r1" }),
      makeItem({ id: "a3", score: 3, service: "svc-A", route: "/r1" }),
      makeItem({ id: "a4", score: 2, service: "svc-A", route: "/r1" }),
      makeItem({ id: "a5", score: 1, service: "svc-A", route: "/r1" }),
    ]
    const result = fill(items, { topGuarantee: 1, maxItems: 10, maxPerDiversityKey: 2 })

    // Phase 1: a1. Phase 2/3: only 1 more from svc-A:/r1 (cap=2, already 1 from Phase 1)
    expect(result).toHaveLength(2)
  })
})

// =============================================================================
// Edge cases
// =============================================================================

describe("edge cases", () => {
  it("empty input → empty output", () => {
    const result = diversityFill([], defaultOpts)
    expect(result).toEqual([])
  })

  it("fewer items than maxItems → returns all items", () => {
    const items = [
      makeItem({ id: "a1", score: 5, service: "svc-A" }),
      makeItem({ id: "b1", score: 3, service: "svc-B" }),
    ]
    const result = fill(items, { maxItems: 10 })
    expect(result).toHaveLength(2)
  })

  it("all items with score=0 → Phase 1 empty, Phase 2/3 handles diversity", () => {
    const items = [
      makeItem({ id: "a1", score: 0, service: "svc-A", route: "/r1" }),
      makeItem({ id: "b1", score: 0, service: "svc-B", route: "/r1" }),
      makeItem({ id: "c1", score: 0, service: "svc-C", route: "/r1" }),
    ]
    const result = fill(items, { topGuarantee: 3, maxItems: 5 })

    // All items returned; service diversity still applied
    expect(result).toHaveLength(3)
    // Service diversity should order: a1, b1, c1 (in input order since scores equal and ids sorted)
    expect(result.map((r) => r.service)).toEqual(["svc-A", "svc-B", "svc-C"])
  })

  it("single item → returns it regardless of score", () => {
    const items = [makeItem({ id: "a1", score: 0, service: "svc-A" })]
    const result = fill(items, { maxItems: 10 })
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe("a1")
  })

  it("maxItems=0 → returns empty", () => {
    const items = [makeItem({ id: "a1", score: 10, service: "svc-A" })]
    const result = fill(items, { maxItems: 0 })
    expect(result).toEqual([])
  })

  it("topGuarantee=0 → no Phase 1, all items go through Phase 2/3", () => {
    const items = [
      makeItem({ id: "a1", score: 10, service: "svc-A", route: "/r1" }),
      makeItem({ id: "b1", score: 5, service: "svc-B", route: "/r1" }),
      makeItem({ id: "c1", score: 3, service: "svc-C", route: "/r1" }),
    ]
    const result = fill(items, { topGuarantee: 0, maxItems: 3 })

    // All through Phase 2/3 with service diversity
    expect(result).toHaveLength(3)
  })

  it("topGuarantee > maxItems → Phase 1 guarantee is sacrosanct, may exceed maxItems", () => {
    const items = [
      makeItem({ id: "a1", score: 10, service: "svc-A" }),
      makeItem({ id: "a2", score: 9, service: "svc-A" }),
      makeItem({ id: "a3", score: 8, service: "svc-A" }),
    ]
    // topGuarantee=5 but maxItems=2 — Phase 1 guarantee is sacrosanct
    const result = fill(items, { topGuarantee: 5, maxItems: 2 })

    // Phase 1 takes all 3 items with score > 0 (up to topGuarantee=5).
    // Budget for Phase 2 = max(0, 2-3) = negative, so Phase 2 never runs.
    // Result = 3 items (exceeds maxItems). This is intended:
    // Phase 1 guarantee is sacrosanct and cannot be capped by maxItems.
    expect(result).toHaveLength(3)
  })

  it("deterministic: same sorted input → same output", () => {
    const items = [
      makeItem({ id: "a1", score: 5, service: "svc-A", route: "/r1" }),
      makeItem({ id: "b1", score: 5, service: "svc-B", route: "/r1" }),
      makeItem({ id: "c1", score: 5, service: "svc-C", route: "/r1" }),
      makeItem({ id: "d1", score: 0, service: "svc-D", route: "/r1" }),
    ]
    const sorted = preSorted(items)
    const r1 = diversityFill(sorted, defaultOpts)
    const r2 = diversityFill(sorted, defaultOpts)

    expect(r1.map((r) => r.id)).toEqual(r2.map((r) => r.id))
  })

  it("duplicate identity keys are handled (same item not double-picked)", () => {
    const items = [
      makeItem({ id: "dup", score: 5, service: "svc-A", route: "/r1" }),
      makeItem({ id: "dup", score: 5, service: "svc-A", route: "/r1" }),
      makeItem({ id: "b1", score: 3, service: "svc-B", route: "/r1" }),
    ]
    const result = fill(items, { topGuarantee: 3, maxItems: 5 })

    // "dup" should appear only once (Phase 1), then b1 fills
    const dupCount = result.filter((r) => r.id === "dup").length
    expect(dupCount).toBe(1)
    expect(result.some((r) => r.id === "b1")).toBe(true)
  })
})
