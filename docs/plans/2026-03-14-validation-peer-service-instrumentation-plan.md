# Validation peer.service Instrumentation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `peer.service` OTel attribute to all outbound dependency spans in `validation/apps/web` so Plan 2's dependency-aware incident formation works across all validation scenarios.

**Architecture:** 4 surgical one-liner additions — one `span.setAttribute("peer.service", <name>)` per outbound call site. No helper abstractions, no new deps, no logic changes. Scenario 5 (CDN is upstream, not downstream) needs no changes.

**Tech Stack:** Node.js (CommonJS), @opentelemetry/api `SpanStatusCode` already imported in each file.

---

### Task 1: Add `peer.service` to `payment.charge` span (Scenario 1 — Stripe)

**Files:**
- Modify: `validation/apps/web/server.js` (`callPayment` function, around line 244)

**Context:**
`callPayment()` wraps Stripe calls in a `payment.charge` span. The span already sets `payment.attempts` and `http.status_code`. We add `peer.service` at the same point.

**Step 1: Make the edit**

In `server.js`, locate the `span.setAttributes` call inside `callPayment` that sets `"payment.attempts"` and `"http.status_code"` (around line 244 — the non-429 return path). Add `"peer.service": "stripe"`:

```js
// Before:
span.setAttributes({
  "payment.attempts": attempt,
  "http.status_code": response.statusCode
});
```

```js
// After:
span.setAttributes({
  "peer.service": "stripe",
  "payment.attempts": attempt,
  "http.status_code": response.statusCode
});
```

Also add to the retry-exhausted path (around line 256–260):

```js
// Before:
span.setAttributes({
  "payment.attempts": attempt,
  "http.status_code": response.statusCode,
  "retry.exhausted": true
});
```

```js
// After:
span.setAttributes({
  "peer.service": "stripe",
  "payment.attempts": attempt,
  "http.status_code": response.statusCode,
  "retry.exhausted": true
});
```

**Step 2: Verify with grep**

```bash
grep -n 'peer.service' validation/apps/web/server.js
```
Expected: 2 matches (both setAttributes blocks in callPayment).

**Step 3: Commit**

```bash
git add validation/apps/web/server.js
git commit -m "fix(validation): add peer.service=stripe to payment.charge span"
```

---

### Task 2: Add `peer.service` to `notification.send` span (Scenario 2 — notification-svc)

**Files:**
- Modify: `validation/apps/web/routes/api-orders.js` (`handleApiOrders` function, around line 81)

**Context:**
`handleApiOrders()` wraps notification-svc calls in a `notification.send` span. The span already sets `notification.latency_ms` and `http.response.status_code`. We add `peer.service` there.

**Step 1: Make the edit**

In `api-orders.js`, locate `notifySpan.setAttributes` (around line 81):

```js
// Before:
notifySpan.setAttributes({
  "notification.latency_ms": latencyMs,
  "http.response.status_code": response.statusCode
});
```

```js
// After:
notifySpan.setAttributes({
  "peer.service": "notification-svc",
  "notification.latency_ms": latencyMs,
  "http.response.status_code": response.statusCode
});
```

Also add `peer.service` to the error path (around line 90, where only `notification.latency_ms` is set):

```js
// Before:
notifySpan.setAttributes({ "notification.latency_ms": latencyMs });
```

```js
// After:
notifySpan.setAttributes({
  "peer.service": "notification-svc",
  "notification.latency_ms": latencyMs
});
```

**Step 2: Verify**

```bash
grep -n 'peer.service' validation/apps/web/routes/api-orders.js
```
Expected: 2 matches.

**Step 3: Commit**

```bash
git add validation/apps/web/routes/api-orders.js
git commit -m "fix(validation): add peer.service=notification-svc to notification.send span"
```

---

### Task 3: Add `peer.service` to `db.query` span (Scenario 3 — postgres)

**Files:**
- Modify: `validation/apps/web/routes/db.js` (`handleDbRecentOrders` function, around line 22)

**Context:**
`handleDbRecentOrders()` creates a `db.query` span with `db.system`, `db.statement`, `db.operation` attributes already set in the span constructor options. We add `peer.service` there.

**Step 1: Make the edit**

In `db.js`, locate `ctx.tracer.startActiveSpan("db.query", { attributes: { ... } }, ...)` (around line 22):

```js
// Before:
return ctx.tracer.startActiveSpan("db.query", {
  attributes: {
    "db.system": "postgresql",
    "db.statement": "SELECT id, status FROM orders ORDER BY id DESC LIMIT 10",
    "db.operation": "select"
  }
}, async (span) => {
```

```js
// After:
return ctx.tracer.startActiveSpan("db.query", {
  attributes: {
    "peer.service": "postgres",
    "db.system": "postgresql",
    "db.statement": "SELECT id, status FROM orders ORDER BY id DESC LIMIT 10",
    "db.operation": "select"
  }
}, async (span) => {
```

**Step 2: Verify**

```bash
grep -n 'peer.service' validation/apps/web/routes/db.js
```
Expected: 1 match.

**Step 3: Commit**

```bash
git add validation/apps/web/routes/db.js
git commit -m "fix(validation): add peer.service=postgres to db.query span"
```

---

### Task 4: Add `peer.service` to `sendgrid.send` span (Scenario 4 — sendgrid)

**Files:**
- Modify: `validation/apps/web/routes/notifications.js` (`handleNotificationsSend` function, around line 58)

**Context:**
`handleNotificationsSend()` wraps SendGrid calls in a `sendgrid.send` span. The span already sets `http.response.status_code`, `deployment.id`, `sendgrid.key_revoked`. We add `peer.service` there.

**Step 1: Make the edit**

In `notifications.js`, locate `span.setAttributes` (around line 58):

```js
// Before:
span.setAttributes({
  "http.response.status_code": response.statusCode,
  "deployment.id": deploymentId,
  "sendgrid.key_revoked": response.statusCode === 401
});
```

```js
// After:
span.setAttributes({
  "peer.service": "sendgrid",
  "http.response.status_code": response.statusCode,
  "deployment.id": deploymentId,
  "sendgrid.key_revoked": response.statusCode === 401
});
```

**Step 2: Verify**

```bash
grep -n 'peer.service' validation/apps/web/routes/notifications.js
```
Expected: 1 match.

**Step 3: Commit**

```bash
git add validation/apps/web/routes/notifications.js
git commit -m "fix(validation): add peer.service=sendgrid to sendgrid.send span"
```

---

### Task 5: Create PR

**Step 1: Push branch and create PR**

```bash
git push -u origin <current-branch>
```

Then create a PR with:
- Title: `fix(validation): add peer.service to outbound dependency spans`
- Body: list the 4 changes, their scenario mapping, and the scenario/dependency coverage table

---

## Scenario Coverage Summary

| Scenario | Dependency | peer.service set | Formation enabled |
|---------|-----------|-----------------|------------------|
| 1 third_party_api_rate_limit_cascade | Stripe | ✅ `"stripe"` | ✅ |
| 2 cascading_timeout_downstream_dependency | notification-svc | ✅ `"notification-svc"` | ✅ |
| 3 db_migration_lock_contention | PostgreSQL | ✅ `"postgres"` | ✅ |
| 4 secrets_rotation_partial_propagation | SendGrid | ✅ `"sendgrid"` | ✅ |
| 5 upstream_cdn_stale_cache_poison | CDN (upstream) | — (CDN is upstream) | N/A |
