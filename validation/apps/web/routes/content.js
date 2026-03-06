function handleDashboard(req, res, ctx) {
  const cdnCacheTtlSec = process.env.CDN_CACHE_TTL_SEC || "300";
  if (ctx.state.mode === "degraded") {
    ctx.sendJson(res, 503, { error: "service degraded", page: "dashboard" }, {
      "cache-control": `public, s-maxage=${cdnCacheTtlSec}`
    });
    return;
  }
  ctx.sendJson(res, 200, { page: "dashboard", content: "Welcome", ts: new Date().toISOString() }, {
    "cache-control": "public, max-age=60"
  });
}

function handleProducts(req, res, ctx) {
  const cdnCacheTtlSec = process.env.CDN_CACHE_TTL_SEC || "300";
  if (ctx.state.mode === "degraded") {
    ctx.sendJson(res, 503, { error: "service degraded", page: "products" }, {
      "cache-control": `public, s-maxage=${cdnCacheTtlSec}`
    });
    return;
  }
  ctx.sendJson(res, 200, { page: "products", items: [], ts: new Date().toISOString() }, {
    "cache-control": "public, max-age=60"
  });
}

module.exports = { handleDashboard, handleProducts };
