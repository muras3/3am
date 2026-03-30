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
  .allowUnknownOption(true)
  .action(async () => {
    await runDiagnose(process.argv.slice(3));
  });

program
  .command("init")
  .description("Set up OpenTelemetry SDK in your project")
  .option("--api-key <key>", "Anthropic API key (saved to ~/.config/3amoncall/credentials)")
  .option("--no-interactive", "Skip interactive prompts (for CI/Claude Code)")
  .action(async (options: { apiKey?: string; interactive?: boolean }) => {
    await runInit(process.argv.slice(3), {
      apiKey: options.apiKey,
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
