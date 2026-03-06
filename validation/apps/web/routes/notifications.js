function handleNotificationsSend(req, res, ctx) {
  ctx.sendJson(res, 501, { error: "not implemented" });
}

module.exports = { handleNotificationsSend };
