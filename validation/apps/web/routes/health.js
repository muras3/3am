function handleHealth(req, res, ctx) {
  ctx.sendJson(res, 200, {
    status: "ok",
    activeWorkers: ctx.state.activeWorkers,
    queueDepth: ctx.state.queue.length
  });
}

function handleMetrics(req, res, ctx) {
  ctx.sendJson(res, 200, {
    service: "validation-web",
    runId: ctx.state.currentRunId,
    activeWorkers: ctx.state.activeWorkers,
    queueDepth: ctx.state.queue.length,
    stats: ctx.state.stats,
    config: ctx.config
  });
}

module.exports = { handleHealth, handleMetrics };
