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

program.parse(process.argv);
