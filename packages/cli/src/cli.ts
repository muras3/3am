#!/usr/bin/env node
import { Argument, Command } from "commander";
import { runDiagnose } from "./commands/diagnose.js";
import { runInit } from "./commands/init.js";
import { runLocal } from "./commands/local.js";

const program = new Command();

program
  .name("3amoncall")
  .description("Diagnose serverless app incidents in under 5 minutes using OTel data + LLM")
  .version("0.1.0");

program
  .command("diagnose")
  .description("Run LLM diagnosis on an incident packet")
  .option("--provider <provider>", "LLM provider (anthropic, openai, ollama, claude-code, codex)")
  .option("--model <model>", "Override provider model")
  .option("--incident-id <id>", "Run manual diagnosis for an incident stored in Receiver")
  .option("--receiver-url <url>", "Receiver base URL for manual diagnosis")
  .option("--auth-token <token>", "Receiver auth token for manual diagnosis")
  .allowUnknownOption(true)
  .action(async () => {
    await runDiagnose(process.argv.slice(3));
  });

program
  .command("init")
  .description("Set up OpenTelemetry SDK in your project")
  .option("--api-key <key>", "Anthropic API key (saved to ~/.config/3amoncall/credentials)")
  .option("--mode <mode>", "Diagnosis mode (automatic or manual)")
  .option("--provider <provider>", "LLM provider (anthropic, openai, ollama, claude-code, codex)")
  .option("--model <model>", "Default provider model override")
  .option("--bridge-url <url>", "Local bridge URL for console-triggered manual runs")
  .option("--no-interactive", "Skip interactive prompts (for CI/Claude Code)")
  .action(async (options: { apiKey?: string; mode?: string; provider?: string; model?: string; bridgeUrl?: string; interactive?: boolean }) => {
    await runInit(process.argv.slice(3), {
      apiKey: options.apiKey,
      mode: options.mode,
      provider: options.provider,
      model: options.model,
      bridgeUrl: options.bridgeUrl,
      noInteractive: options.interactive === false,
    });
  });

program
  .command("local")
  .description("Use 3amoncall locally (default action: start)")
  .option("--port <number>", "Port to expose (default: 3333)", parseInt)
  .option("--yes", "Skip cost consent prompt when running the demo")
  .option("--no-interactive", "Skip interactive prompts")
  .option("--receiver-url <url>", "Receiver URL for local demo (default: http://localhost:3333)")
  .addArgument(new Argument("[action]").choices(["start", "demo"]))
  .action(async (action: "start" | "demo" | undefined, options: {
    port?: number;
    yes?: boolean;
    interactive?: boolean;
    receiverUrl?: string;
  }) => {
    await runLocal({
      action,
      port: options.port,
      yes: options.yes,
      noInteractive: options.interactive === false,
      receiverUrl: options.receiverUrl,
    });
  });

program
  .command("bridge")
  .description("Start the local LLM bridge for manual console actions")
  .option("--port <number>", "Port to expose (default: 4269)", parseInt)
  .action(async (options: { port?: number }) => {
    const { runBridge } = await import("./commands/bridge.js");
    runBridge(options.port != null ? { port: options.port } : {});
  });

program
  .command("deploy")
  .description("Deploy Receiver to a hosted target")
  .addArgument(new Argument("<platform>").choices(["vercel", "cloudflare"]))
  .option("--project-name <name>", "Project name override for platform provisioning")
  .option("--setup", "Force first-time setup flow")
  .option("--no-setup", "Force re-deploy flow (requires --auth-token)")
  .option("--auth-token <token>", "Auth token for re-deploy")
  .option("--yes", "Skip all confirmation prompts")
  .option("--no-interactive", "CI mode (requires --yes and an explicit target)")
  .option("--json", "Output results as JSON")
  .action(
    async (platform: "vercel" | "cloudflare" | undefined, options: {
      projectName?: string;
      setup?: boolean;
      authToken?: string;
      yes?: boolean;
      interactive?: boolean;
      json?: boolean;
    }) => {
      const { runDeploy } = await import("./commands/deploy.js");
      await runDeploy(process.argv.slice(3), {
        platform,
        projectName: options.projectName,
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
