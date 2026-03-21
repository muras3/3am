# Console Implementation Planning Input

Purpose:
- Provide a stable planning input for implementation planning.
- Do not define UI direction again.
- Do not rewrite the validated mock.
- Do not expand scope beyond the current public release target.

Source of truth:
- `docs/mock/lens-prototype-v1.html`
- `docs/design/console-data-requirements.md`
- `docs/product-concept-v0.2.md`

## 1. Goal

Implement the validated console experience for public OSS release.

The goal is not to recreate the mock visually for its own sake.
The goal is to make the product behave so that, during an incident:
- `normal` shows an observed runtime dependency map
- `incident` acts as a decision room
- `evidence` acts as a proof browser
- operators can understand:
  - what is happening
  - what to do now
  - why that action is justified

## 2. Working Assumptions

- The validated mock is complete enough to stop further UX exploration.
- The main remaining work is implementation, not concept design.
- Raw telemetry alone is not sufficient for the new UI.
- The new UI depends on curated API responses.
- `IncidentPacket` remains the raw fact contract.
- A separate deterministic reasoning layer is required on top of the packet.
- A second narrative layer is required on top of the deterministic layer.

## 3. Release Scope

Current release scope:
- OTel traces
- OTel logs
- OTel metrics

Out of scope:
- platform logs as a primary evidence surface
- resurrecting a separate chat panel
- generic observability dashboard behavior

If platform data appears at all, it is secondary and must not drive the primary UI.

## 4. Screen Roles

### Normal

Role:
- runtime dependency map

Primary:
- observed call paths
- node health
- anomaly propagation

Not primary:
- architecture diagram
- service catalog
- dashboard metric tiles

### Incident

Role:
- decision room

Primary:
- immediate action
- blast radius
- confidence
- operator checks
- root cause hypothesis
- causal chain
- evidence entry

Not primary:
- raw telemetry
- chat
- separate timeline card
- generic monitoring layout

### Evidence

Role:
- proof browser

Primary:
- question -> answer -> supporting evidence
- expected vs observed
- claim-driven evidence

Not primary:
- raw log viewer
- generic chart explorer
- generic trace explorer

## 5. API Direction

Treat these as the new UI-facing contract surface.

### Curated APIs

- `GET /api/runtime-map`
- `GET /api/incidents/:id` (extended)
- `GET /api/incidents/:id/evidence`

### Raw APIs

Existing raw APIs may remain for debugging, support, or migration:
- `/api/services`
- `/api/activity`
- `/api/incidents/:id/telemetry/spans`
- `/api/incidents/:id/telemetry/metrics`
- `/api/incidents/:id/telemetry/logs`
- `/api/chat/:id`

But the new console must not depend on them as its primary contract.

## 6. Layer Responsibilities

### Receiver

Owns deterministic reasoning structure:
- runtime map node and edge derivation
- blast radius calculation
- evidence counts
- expected vs observed selection inputs
- grouped traces / metrics / logs
- proof references
- absence evidence candidates

### Diagnosis

Owns narrative generation:
- incident summary wording
- action wording
- confidence rationale
- risk wording
- proof card summaries
- Q&A answers
- follow-up questions
- absence evidence explanation wording

### Frontend

Owns rendering and interaction:
- layout
- navigation
- highlighting
- expansion/collapse
- deep link state
- formatting for times, percentages, labels

The frontend must not perform inference, grouping, clustering, or fallback reasoning.

## 7. Two-Stage Prompting

Prompting is split into two stages.

### Stage 1: Incident Diagnosis

Input:
- incident packet

Output:
- root cause
- immediate action
- causal chain
- operator checks
- confidence

Purpose:
- determine what happened

### Stage 2: Console Narrative Generation

Input:
- deterministic reasoning structure from receiver
- diagnosis result from stage 1

Output:
- proof card summaries
- confidence rationale
- risk wording
- Q&A answer and follow-ups
- evidence-oriented narrative labels

Purpose:
- translate structured evidence into operator-readable console language

## 8. Evidence Studio Requirement

Evidence Studio is not a chat UI.

It must integrate:
- the operator's question
- the generated answer
- the evidence supporting that answer

This means:
- answers need evidence refs
- proof cards need evidence refs
- traces / metrics / logs need stable ids or group ids
- the UI must visually connect the answer to the supporting evidence

The required mental model is:
- expected behavior
- observed incident behavior
- deviation
- why that deviation matters

## 9. Parallel Branch Strategy

Parallel development is allowed, but only after the contract is fixed.

Recommended lanes:
- `receiver`
- `diagnosis`
- `frontend`
- `integration`

Parallel branch work is valid only if:
- curated API shapes are treated as fixed
- frontend uses fixtures based on those shapes
- frontend does not invent missing backend behavior
- backend does not optimize around old raw-only UI assumptions

## 10. What Planning Should Produce

The next planning step should produce:
- implementation order
- work split across the four lanes
- dependency edges between tasks
- integration checkpoints
- explicit risks and blockers

The next planning step should not:
- reopen the validated mock
- redesign the UX
- expand product scope
- replace curated APIs with raw-only APIs
