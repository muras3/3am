import { runDev, type DevOptions } from "./dev.js";
import { runDemo, type DemoOptions } from "./demo.js";

export type LocalAction = "start" | "demo";

export interface LocalOptions extends DevOptions, DemoOptions {
  action?: string;
}

export async function runLocal(options: LocalOptions = {}): Promise<void> {
  const action = options.action ?? "start";

  if (action === "start") {
    runDev(options.port != null ? { port: options.port } : {});
    return;
  }

  if (action === "demo") {
    await runDemo([], {
      yes: options.yes,
      noInteractive: options.noInteractive,
      receiverUrl: options.receiverUrl,
    });
    return;
  }

  process.stderr.write(
    `Error: unknown local action "${action}". Use "start" or "demo".\n`,
  );
  process.exit(1);
}
