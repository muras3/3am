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

  ctx.enqueueWork(async () => {
    return ctx.tracer.startActiveSpan("db.query", {
      attributes: {
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
  }).catch((err) => {
    if (err.statusCode === 504) {
      ctx.sendJson(res, 504, { error: "queue timeout" });
    } else {
      ctx.sendJson(res, 500, { error: "query failed", message: err.message });
    }
  });
}

module.exports = { handleDbRecentOrders };
