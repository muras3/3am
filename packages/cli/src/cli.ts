#!/usr/bin/env node
import { Command } from "commander";
import { runDiagnose } from "./commands/diagnose.js";
import { runInit, runUpgrade } from "./commands/init.js";
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
  .description("Set up OpenTelemetry SDK in your project")
  .option("--upgrade", "Upgrade local OTel config to point to production Receiver")
  .action(async (options: { upgrade?: boolean }) => {
    if (options.upgrade) {
      await runUpgrade(process.argv.slice(3));
    } else {
      await runInit(process.argv.slice(3));
    }
  });

program
  .command("dev")
  .description("Start local 3amoncall Receiver via Docker (Requires Docker Desktop)")
  .option("--port <number>", "Port to expose (default: 3333)", parseInt)
  .action((options: { port?: number }) => {
    runDev({ port: options.port });
  });

program.parse(process.argv);
