# Design: validation peer.service instrumentation fix

## Problem

Plan 2's dependency-aware formation reads `peer.service` from outbound spans.
All 4 outbound dependencies in `validation/apps/web` are missing this attribute,
so every scenario falls back to service-only grouping (`dependency = undefined`).

## Scope

4 files, 1–2 line additions each. No logic changes.

## Changes

| File | Span | peer.service value |
|------|------|--------------------|
| `validation/apps/web/server.js` `callPayment()` | `payment.charge` | `"stripe"` |
| `validation/apps/web/routes/api-orders.js` `handleApiOrders()` | `notification.send` | `"notification-svc"` |
| `validation/apps/web/routes/db.js` `handleDbRecentOrders()` | `db.query` | `"postgres"` |
| `validation/apps/web/routes/notifications.js` `handleNotificationsSend()` | `sendgrid.send` | `"sendgrid"` |

Scenario 5 (CDN) is not changed — CDN is upstream of web, not a downstream dependency.

## peer.service value rationale

Logical service names (not Docker hostnames) to match Plan 2 OC-8 expectation:
`affectedDependencies: ["stripe"]`. `normalizeDependency()` passes these through
(not loopback, not bare IP).

## Expected outcome

| Scenario | Before | After |
|---------|--------|-------|
| 1 third_party_api_rate_limit_cascade | dependency=undefined | dependency="stripe" |
| 2 cascading_timeout_downstream_dependency | dependency=undefined | dependency="notification-svc" |
| 3 db_migration_lock_contention | dependency=undefined | dependency="postgres" |
| 4 secrets_rotation_partial_propagation | dependency=undefined | dependency="sendgrid" |
| 5 upstream_cdn_stale_cache_poison | no change | no change |
