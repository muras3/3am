const http = require("http");
const { URL } = require("url");
const { SpanStatusCode } = require("@opentelemetry/api");

function handleNotificationsSend(req, res, ctx) {
  const deploymentId = req.headers["x-deployment-id"] || process.env.DEPLOYMENT_ID || "default";
  const sendgridApiKey = process.env.SENDGRID_API_KEY;
  const sendgridBaseUrl = process.env.SENDGRID_BASE_URL || "http://mock-sendgrid:6001";

  if (!sendgridApiKey) {
    ctx.sendJson(res, 501, { error: "SENDGRID_API_KEY not configured" });
    return;
  }

  ctx.enqueueWork(async () => {
    return ctx.tracer.startActiveSpan("sendgrid.send", async (span) => {
      try {
        const url = new URL("/v3/mail/send", sendgridBaseUrl);
        const payload = JSON.stringify({
          to: "customer@example.com",
          subject: "Order confirmation",
          text: "Your order is confirmed"
        });

        const response = await new Promise((resolve, reject) => {
          const r = http.request(
            {
              method: "POST",
              hostname: url.hostname,
              port: url.port,
              path: url.pathname,
              headers: {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
                "authorization": `Bearer ${sendgridApiKey}`
              }
            },
            (resp) => {
              const chunks = [];
              resp.on("data", (chunk) => chunks.push(chunk));
              resp.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
                let parsed = {};
                try {
                  parsed = JSON.parse(raw);
                } catch (e) {
                  parsed = { raw };
                }
                resolve({ statusCode: resp.statusCode || 500, body: parsed });
              });
            }
          );
          r.on("error", reject);
          r.write(payload);
          r.end();
        });

        span.setAttributes({
          "sendgrid.status_code": response.statusCode,
          "deployment.id": deploymentId,
          "sendgrid.key_revoked": response.statusCode === 401
        });

        if (response.statusCode === 202) {
          ctx.sendJson(res, 200, { sent: true, deployment_id: deploymentId });
          return;
        }

        if (response.statusCode === 401 || response.statusCode === 403) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: "sendgrid auth failure" });
          ctx.log("error", "sendgrid auth failure", {
            deployment_id: deploymentId,
            status_code: response.statusCode
          });
          ctx.sendJson(res, 502, {
            error: "sendgrid auth failure",
            status_code: response.statusCode,
            deployment_id: deploymentId
          });
          return;
        }

        ctx.sendJson(res, 502, {
          error: "sendgrid error",
          status_code: response.statusCode
        });
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        ctx.sendJson(res, 502, { error: error.message });
      } finally {
        span.end();
      }
    });
  }, ctx.config.checkoutTimeoutMs || 30000);
}

module.exports = { handleNotificationsSend };
