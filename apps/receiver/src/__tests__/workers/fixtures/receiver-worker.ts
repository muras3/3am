import receiver, { _resetRuntimeForTest } from "../../../cf-entry.js";

function withTestEnv(env: Record<string, unknown>): Record<string, unknown> {
  return {
    ...env,
    ALLOW_INSECURE_DEV_MODE: "true",
    ANTHROPIC_API_KEY: "workers-test-key",
    RECEIVER_AUTH_TOKEN: undefined,
  };
}

export default {
  fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext): Promise<Response> {
    _resetRuntimeForTest();
    return receiver.fetch(request, withTestEnv(env) as never, ctx);
  },
  queue(batch: MessageBatch, env: Record<string, unknown>, ctx: ExecutionContext): Promise<void> {
    _resetRuntimeForTest();
    return receiver.queue!(batch, withTestEnv(env) as never, ctx);
  },
};
