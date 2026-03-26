#!/usr/bin/env node
import { Command } from "commander";
import { runDiagnose } from "./commands/diagnose.js";
import { runInit } from "./commands/init.js";
import { runDev } from "./commands/dev.js";

const program = new Command();

program
  .name("3amoncall")
  .description("Diagnose serverless app incidents in under 5 minutes using OTel data + LLM")
  .version("0.1.0");

program
  .command("diagnose")
  .description("Run LLM diagnosis on an incident packet")
  .allowUnknownOption(true)
  .action(async () => {
    await runDiagnose(process.argv.slice(3));
  });

program
  .command("init")
  .description("Set up OpenTelemetry SDK in your project and start local Receiver")
  .option("--api-key <key>", "Anthropic API key (saved to ~/.config/3amoncall/credentials)")
  .option("--no-interactive", "Skip interactive prompts (for CI/Claude Code)")
  .action(async (options: { apiKey?: string; interactive?: boolean }) => {
    await runInit(process.argv.slice(3), {
      apiKey: options.apiKey,
      noInteractive: options.interactive === false,
    });
  });

program
  .command("dev")
  .description("Start local 3amoncall Receiver via Docker")
  .option("--port <number>", "Port to expose (default: 3333)", parseInt)
  .action((options: { port?: number }) => {
    runDev(options.port != null ? { port: options.port } : {});
  });

program
  .command("demo")
  .description("Run a demo incident with real LLM diagnosis (local/dev only)")
  .option("--yes", "Skip cost consent prompt")
  .option("--no-interactive", "Skip interactive prompts")
  .option("--receiver-url <url>", "Receiver URL (default: http://localhost:3333)")
  .action(async (options: { yes?: boolean; interactive?: boolean; receiverUrl?: string }) => {
    const { runDemo } = await import("./commands/demo.js");
    await runDemo(process.argv.slice(3), {
      yes: options.yes,
      noInteractive: options.interactive === false,
      receiverUrl: options.receiverUrl,
    });
  });

program
  .command("deploy")
  .description("Deploy Receiver to Vercel or Cloudflare and configure credentials")
  .option("--platform <platform>", "Target platform (vercel or cloudflare)")
  .option("--setup", "Force first-time setup flow")
  .option("--no-setup", "Force re-deploy flow (requires --auth-token)")
  .option("--auth-token <token>", "Auth token for re-deploy")
  .option("--yes", "Skip all confirmation prompts")
  .option("--no-interactive", "CI mode (requires --yes and --platform)")
  .option("--json", "Output results as JSON")
  .action(
    async (options: {
      platform?: string;
      setup?: boolean;
      authToken?: string;
      yes?: boolean;
      interactive?: boolean;
      json?: boolean;
    }) => {
      const { runDeploy } = await import("./commands/deploy.js");
      await runDeploy(process.argv.slice(3), {
        platform: options.platform as "vercel" | "cloudflare" | undefined,
        setup: options.setup,
        noSetup: options.setup === false,
        authToken: options.authToken,
        yes: options.yes,
        noInteractive: options.interactive === false,
        json: options.json,
      });
    },
  );

program.parse(process.argv);
