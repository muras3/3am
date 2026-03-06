const http = require("http");
const { URL } = require("url");
const { SpanStatusCode } = require("@opentelemetry/api");

const NOTIFICATION_SVC_URL = process.env.NOTIFICATION_SVC_URL || "http://mock-notification-svc:7001";

function requestNotification(body) {
  const url = new URL("/api/notify", NOTIFICATION_SVC_URL);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload)
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = {};
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            parsed = { raw };
          }
          resolve({ statusCode: res.statusCode || 500, body: parsed });
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function handleApiOrders(req, res, ctx) {
  const { state, config, counters, histograms, enqueueWork, sendJson, log, runAttrs } = ctx;
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    let body = {};
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    } catch (error) {
      sendJson(res, 400, { error: "invalid json body" });
      return;
    }

    state.stats.orderRequests += 1;
    counters.orderRequestCounter.add(1, runAttrs({ route: "/api/orders" }));
    const orderId = `ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();

    ctx.tracer.startActiveSpan("api_orders.request", async (span) => {
      span.setAttributes({
        "app.route": "/api/orders",
        "app.order_id": orderId,
        "validation.run_id": state.currentRunId
      });

      try {
        const result = await enqueueWork(async (queueWaitMs) => {
          span.setAttribute("queue.wait_ms", queueWaitMs);

          const notifyStartedAt = Date.now();
          await ctx.tracer.startActiveSpan("notification.send", async (notifySpan) => {
            try {
              const response = await requestNotification({
                orderId,
                customerId: body.customerId || "cust_default",
                message: "Your order has been placed"
              });
              const latencyMs = Date.now() - notifyStartedAt;
              notifySpan.setAttributes({
                "notification.latency_ms": latencyMs,
                "notification.status_code": response.statusCode
              });
              log("info", "notification sent", { orderId, latencyMs });
              notifySpan.end();
              return response;
            } catch (error) {
              const latencyMs = Date.now() - notifyStartedAt;
              notifySpan.setAttributes({ "notification.latency_ms": latencyMs });
              notifySpan.recordException(error);
              notifySpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
              notifySpan.end();
              throw error;
            }
          });

          return { statusCode: 200, payload: { orderId, notified: true } };
        }, config.checkoutTimeoutMs || 30000);

        histograms.orderDuration.record(Date.now() - startedAt, runAttrs({ route: "/api/orders" }));
        span.setAttributes({ "http.status_code": result.statusCode });
        sendJson(res, result.statusCode, {
          ...result.payload,
          durationMs: Date.now() - startedAt
        });
      } catch (error) {
        state.stats.orderFailures += 1;
        state.stats.route504s += 1;
        counters.orderFailureCounter.add(1, runAttrs({ route: "/api/orders" }));
        counters.route504Counter.add(1, runAttrs({ route: "/api/orders" }));
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });

        if (error.statusCode === 504) {
          sendJson(res, 504, {
            error: "worker pool queue timed out",
            note: "pool exhausted by slow notification calls",
            orderId,
            durationMs: Date.now() - startedAt
          });
        } else {
          sendJson(res, 502, {
            error: "notification failed",
            orderId,
            durationMs: Date.now() - startedAt
          });
        }
      } finally {
        span.end();
      }
    });
  });
}

module.exports = { handleApiOrders };
