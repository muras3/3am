# Self-Instrumentation

3am emits self telemetry about the receiver itself so the product can be dogfooded without pretending the Vercel and Cloudflare runtimes behave identically.

## Scope

The current scope is intentionally narrow and explainable:

- receiver inbound HTTP paths, including `/healthz`, `/v1/traces`, and `/api/*`
- receiver request completion logs with method, path, status, and duration
- Node/Vercel outbound `fetch` and Undici activity when the runtime performs internal HTTP calls

This scope is enough to verify that 3am itself emits real traces and logs without mixing those signals into normal application ingest by default.

## Platform Behavior

### Vercel / Node.js

Supported path:

- `api/index.ts` initializes the Node OpenTelemetry SDK before the receiver handler is exported
- `apps/receiver/src/server.ts` initializes the same SDK for local and containerized Node execution
- HTTP and Undici instrumentation produce self traces
- receiver middleware emits self logs through OTLP log export

Required environment:

```bash
SELF_OTEL_ENABLED=true
SELF_OTEL_EXPORTER_OTLP_ENDPOINT=https://your-otel-backend.example.com
```

Recommended resource naming:

```bash
SELF_OTEL_SERVICE_NAME=3am-receiver
SELF_OTEL_SERVICE_NAMESPACE=3am
SELF_OTEL_DEPLOYMENT_ENVIRONMENT=production
```

### Cloudflare Workers

Experimental path:

- `apps/receiver/wrangler.toml` enables Workers Observability traces and invocation logs
- `apps/receiver/src/cf-entry.ts` preserves structured request logs through `console`
- traces and logs come from Cloudflare's runtime-managed automatic path
- self metrics are intentionally out of scope

This means the runtime contract is "3am itself emits observable traces and logs on Workers", not "the Worker and Node implementation are byte-for-byte symmetric".

## Validation

### Local black-box validation

Run:

```bash
pnpm install
pnpm --filter @3am/receiver test:self-instrumentation
```

The integration test:

- starts a real OTLP HTTP sink
- starts the receiver as an actual HTTP server with self-instrumentation enabled
- sends real requests to `/healthz`, `/v1/traces`, `/api/incidents`, and a 404 path
- verifies real OTLP trace and log exports were received
- verifies `service.name=3am-receiver`
- verifies a 404 request path also emitted telemetry

### Vercel deployment checks

After deployment:

1. Configure the `SELF_OTEL_*` environment variables.
2. Hit `/healthz` and one authenticated `/api/*` route.
3. Send one OTLP request to `/v1/traces`.
4. In your OTLP backend, confirm traces and logs exist for `service.name=3am-receiver`.
5. Confirm self telemetry is arriving in the dedicated dogfooding destination, not the same incident stream used for application telemetry.

### Cloudflare deployment checks

After deployment:

1. Deploy the Worker with Workers Observability enabled.
2. Hit `/healthz`, `/api/*`, and `/v1/traces`.
3. In Cloudflare Observability, confirm trace and log events exist for the Worker.
4. If exporting those signals onward, verify the downstream backend receives traces and logs.
5. Do not expect self metrics from the Worker path.
