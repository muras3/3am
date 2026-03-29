import { createApp } from "../../../index.js";
import { MemoryAdapter } from "../../../storage/adapters/memory.js";
import { MemoryTelemetryAdapter } from "../../../telemetry/adapters/memory.js";

const app = createApp(new MemoryAdapter(), {
  telemetryStore: new MemoryTelemetryAdapter(),
  resolvedAuthToken: "workers-test-token",
});

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
};
