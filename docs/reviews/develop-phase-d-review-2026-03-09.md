# Phase D Review -- 2026-03-09

**PR**: #44 (`feat/phase-d-console` -> `develop`)
**Reviewer**: Opus 4.6
**Rounds**: 2 (of max 3)

## Summary

Solid architecture and component decomposition. ADR 0025 responsiveness-first is well-served: EvidenceStudio is lazy-loaded, IncidentBoard is lazy-loaded at the route level, staleTime is used on queries. Auth policy comment in `client.ts` is clear and correct. Tests are well-structured and cover data contracts, empty states, ESC close, and tab switching.

Build/test/typecheck/lint all pass. 23 tests, 7 test files.

**However, the center board and evidence studio will render as unstyled raw HTML** because the CSS for those sections was never added to the stylesheets.

## Blocking Issues

### B-1: Missing CSS for board components and evidence overlay (~180 lines)

`shell.css` contains only the app shell styles (topbar, grid, rails, copilot, common). All CSS for the center board sections and evidence studio overlay is missing:

- Board: `.section-what`, `.headline`, `.impact-chips`, `.chip`, `.chip-*`, `.section-action`, `.eyebrow`, `.action-text`, `.action-why`, `.section-chain`, `.label`, `.chain-flow`, `.chain-step`, `.chain-step[data-type=*]`, `.chain-connector`, `.bottom-grid`, `.bottom-card`, `.card-title`, `.watch-row`, `.ws-*`, `.timeline-row`, `.tt`, `.te`, `.evidence-preview-row`, `.ep-label`, `.ep-value`, `.btn-evidence`
- Evidence overlay: `.overlay`, `.evidence-modal`, `.modal-header`, `.mh-left`, `.mh-eyebrow`, `.mh-title`, `.btn-close`, `.evidence-tabs`, `.ev-tab`, `.evidence-content`, `.evidence-main`, `.evidence-side`, `.trace-attrs`, `.trace-attrs-head`, `.trace-attrs-row`, `.ta-span`, `.ta-svc`, `.ta-attrs`

All these classes are present in the mock (`docs/mock/incident-console-v3.html`) but were not carried over.

**Status**: Fixed in Round 1

## Medium Issues

### M-1: Unsafe `context as` cast in `routes/index.tsx:10`

```typescript
const queryClient = (context as { queryClient: QueryClient }).queryClient;
```

TanStack Router supports typed context via `createRootRouteWithContext<{ queryClient: QueryClient }>()`. The current `as` cast bypasses type safety.

### M-2: `AppShell.tsx:11` -- params extraction via `routerState.matches`

```typescript
const currentIncidentId = (routerState.matches.at(-1)?.params as Record<string, string> | undefined)?.["incidentId"];
```

Relies on the last match always having `incidentId`. Fragile if routes change.

### M-3: `WhatHappened.tsx` hardcodes "customer-facing" chip

Always renders `<Chip label="customer-facing" variant="critical" />` regardless of actual impact data.

### M-4: `recommendation.do_not` conditional check vs non-optional schema

`ImmediateAction.tsx:18` checks `recommendation.do_not && (...)` but the Zod schema defines `do_not: z.string()` (required). Defensive but misleading.

## Minor Issues

- m-1: `EvidenceStudio.tsx` overlay missing `role="dialog"` and `aria-modal="true"`
- m-2: Index-based `key` in `ImpactTimeline.tsx`
- m-3: Router context type not connected to `createRouter()`

## Completion Conditions Check

| Condition | Status |
|-----------|--------|
| 3-column layout operational | PASS |
| Evidence Studio opens/closes (ESC + button) | PASS |
| Empty states (0 incidents, diagnosis pending, 404, API error, Evidence Studio empty) | PASS |
| First viewport: What happened / Immediate Action / Why This Action / Open Evidence Studio | PASS (after CSS fix) |
| Right rail = static copilot only | PASS |
| build/test/typecheck/lint green | PASS |
| CI steps added | PASS |

## Verdict

Round 1: **REQUEST CHANGES** (1 blocking: missing CSS)
Round 2: **APPROVE** -- blocking issue fixed, all completion conditions met
