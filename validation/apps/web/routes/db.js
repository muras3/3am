const { Pool } = require("pg");
const { SpanStatusCode } = require("@opentelemetry/api");

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

function handleDbRecentOrders(req, res, ctx) {
  const timeoutMs = (ctx.config && ctx.config.orderTimeoutMs) || 30000;
  return ctx.tracer.startActiveSpan("db.recent_orders.request", {
    attributes: {
      "app.route": "/db/recent-orders",
      "validation.run_id": ctx.state.currentRunId
    }
  }, async (requestSpan) => {
    ctx.enqueueWork(async () => {
      return ctx.tracer.startActiveSpan("db.query", {
        attributes: {
          "peer.service": "postgres",
          "db.system": "postgresql",
          "db.statement": "SELECT id, status FROM orders ORDER BY id DESC LIMIT 10",
          "db.operation": "select"
        }
      }, async (span) => {
        try {
          const result = await getPool().query("SELECT id, status FROM orders ORDER BY id DESC LIMIT 10");
          span.end();
          return result.rows;
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
          span.recordException(err);
          span.end();
          throw err;
        }
      });
    }, timeoutMs).then((rows) => {
      ctx.sendJson(res, 200, { orders: rows });
      requestSpan.end();
    }).catch((err) => {
      requestSpan.recordException(err);
      requestSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      if (err.statusCode === 504) {
        ctx.log("error", "db recent-orders queue timeout", { timeoutMs });
        ctx.sendJson(res, 504, { error: "queue timeout" });
      } else {
        ctx.log("error", "db recent-orders query failed", { message: err.message });
        ctx.sendJson(res, 500, { error: "query failed", message: err.message });
      }
      requestSpan.end();
    });
  });
}

module.exports = { handleDbRecentOrders };
