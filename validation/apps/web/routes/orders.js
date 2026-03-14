const { SpanStatusCode } = require("@opentelemetry/api");

async function handleOrder(res, orderId, ctx) {
  const { state, config, counters, histograms, enqueueWork, sendJson, log, runAttrs, sleep } = ctx;

  state.stats.orderRequests += 1;
  counters.orderRequestCounter.add(1, runAttrs({ route: "/orders/:id" }));
  const startedAt = Date.now();
  return ctx.tracer.startActiveSpan("orders.request", async (span) => {
    span.setAttributes({
      "app.route": "/orders/:id",
      "app.order_id": orderId,
      "validation.run_id": state.currentRunId
    });
    try {
      if (state.activeWorkers >= config.checkoutConcurrency && state.queue.length >= config.orderQueueFailThreshold) {
        state.stats.orderFailures += 1;
        state.stats.route504s += 1;
        counters.orderFailureCounter.add(1, runAttrs({ route: "/orders/:id" }));
        counters.route504Counter.add(1, runAttrs({ route: "/orders/:id" }));
        span.setStatus({ code: SpanStatusCode.ERROR, message: "shared worker pool saturated" });
        sendJson(res, 504, {
          error: "shared worker pool saturated",
          orderId,
          queueDepth: state.queue.length
        });
        return;
      }
      const result = await enqueueWork(async (queueWaitMs) => {
        span.setAttribute("queue.wait_ms", queueWaitMs);
        await sleep(15);
        const order = state.orders.get(orderId);
        if (!order) {
          span.setAttributes({ "http.response.status_code": 404 });
          return { statusCode: 404, payload: { error: "order not found", orderId } };
        }
        span.setAttributes({ "http.response.status_code": 200 });
        return { statusCode: 200, payload: order };
      }, config.orderTimeoutMs);
      histograms.orderDuration.record(Date.now() - startedAt, runAttrs({ route: "/orders/:id" }));
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      state.stats.orderFailures += 1;
      state.stats.route504s += 1;
      counters.orderFailureCounter.add(1, runAttrs({ route: "/orders/:id" }));
      counters.route504Counter.add(1, runAttrs({ route: "/orders/:id" }));
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

module.exports = { handleOrder };
