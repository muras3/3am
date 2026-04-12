const { SpanKind, SpanStatusCode } = require("@opentelemetry/api");

async function handleCheckout(req, res, body, ctx) {
  const { state, config, counters, histograms, enqueueWork, callPayment, sendJson, log, runAttrs } = ctx;

  state.stats.checkoutRequests += 1;
  counters.checkoutRequestCounter.add(1, runAttrs({ route: "/checkout" }));
  const orderId = `ord_${String(state.nextOrderId++).padStart(6, "0")}`;
  const startedAt = Date.now();
  return ctx.tracer.startActiveSpan("checkout.request", { kind: SpanKind.SERVER }, async (span) => {
    span.setAttributes({
      "app.route": "/checkout",
      "app.order_id": orderId,
      "validation.run_id": state.currentRunId
    });
    try {
      const result = await enqueueWork(async (queueWaitMs) => {
        span.setAttribute("queue.wait_ms", queueWaitMs);
        const payment = await callPayment(orderId);
        const order = {
          id: orderId,
          sku: body.sku || "demo-sku",
          status: payment.response.statusCode === 200 ? "paid" : "pending",
          queueWaitMs,
          paymentAttempts: payment.attempt
        };
        state.orders.set(orderId, order);
        if (payment.response.statusCode === 200) {
          state.stats.checkoutSuccesses += 1;
          log("info", "checkout completed", { orderId, queueWaitMs, paymentAttempts: payment.attempt });
          span.setAttributes({
            "payment.attempts": payment.attempt,
            "http.response.status_code": 200
          });
          return { statusCode: 200, payload: order };
        }
        state.stats.checkoutFailures += 1;
        state.stats.route504s += 1;
        counters.checkoutFailureCounter.add(1, runAttrs({ route: "/checkout" }));
        counters.route504Counter.add(1, runAttrs({ route: "/checkout" }));
        log("error", "checkout failed after retries", { orderId, queueWaitMs, paymentAttempts: payment.attempt });
        span.setAttributes({
          "payment.attempts": payment.attempt,
          "http.response.status_code": 504
        });
        span.setStatus({ code: SpanStatusCode.ERROR, message: "payment retries exhausted" });
        return {
          statusCode: 504,
          payload: {
            error: "upstream payment retries exhausted shared worker pool",
            orderId,
            queueWaitMs,
            paymentAttempts: payment.attempt
          }
        };
      }, config.checkoutTimeoutMs);
      histograms.checkoutDuration.record(Date.now() - startedAt, runAttrs({ route: "/checkout" }));
      sendJson(res, result.statusCode, {
        ...result.payload,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      state.stats.checkoutFailures += 1;
      state.stats.route504s += 1;
      counters.checkoutFailureCounter.add(1, runAttrs({ route: "/checkout" }));
      counters.route504Counter.add(1, runAttrs({ route: "/checkout" }));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      sendJson(res, error.statusCode || 500, {
        error: error.message,
        orderId,
        durationMs: Date.now() - startedAt
      });
    } finally {
      span.end();
    }
  });
}

module.exports = { handleCheckout };
