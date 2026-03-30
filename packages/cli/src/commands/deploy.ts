/**
 * `npx 3amoncall deploy` — deploy the Receiver to Vercel or Cloudflare,
 * then wire up the app's .env with the deployed URL and auth token.
 *
 * Orchestration flow:
 *  1. Validate flags
 *  2. Resolve ANTHROPIC_API_KEY
 *  3. Platform selection
 *  4. Detect platform CLI
 *  5. Check platform auth
 *  6. Confirm deploy
 *  7. Run platform deploy
 *  8. Wait for Receiver readiness
 *  9. Get AUTH_TOKEN (setup-token or prompt)
 * 10. Update .env
 * 11. Completion output
 *
 * - No npm dependencies — only Node built-ins
 * - All human-readable output via process.stdout.write / process.stderr.write
 * - When --json is set, ALL human text goes to process.stderr.write
 * - Error exits: process.stderr.write + process.exit(1) + return
 */
import { createInterface } from "node:readline";
import {
  detectPlatformCli,
  checkPlatformAuth,
  promptPlatformSelection,
  type Platform,
} from "./deploy/platform.js";
import { createProvider } from "./deploy/provider.js";
import { updateAppEnv, promptAuthToken } from "./deploy/env-writer.js";
import { waitForReceiver, fetchSetupToken } from "./shared/health.js";
import { resolveApiKey } from "./init/credentials.js";

export interface DeployOptions {
  platform?: "vercel" | "cloudflare";
  projectName?: string;
  /** --setup: force first-time flow */
  setup?: boolean;
  /** --no-setup: force re-deploy flow */
  noSetup?: boolean;
  /** --auth-token: for re-deploy */
  authToken?: string;
  /** --yes: skip confirmations */
  yes?: boolean;
  /** --no-interactive: CI mode */
  noInteractive?: boolean;
  /** --json: structured output */
  json?: boolean;
}

/**
 * Write a human-readable line.
 * When --json is set, routes to stderr so stdout stays clean for JSON.
 */
function info(message: string, json: boolean): void {
  if (json) {
    process.stderr.write(message);
  } else {
    process.stdout.write(message);
  }
}

/**
 * Prompt for a yes/no confirmation.
 * Returns true for "y", "yes", or empty input (default yes).
 */
async function promptConfirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "" || a === "y" || a === "yes");
    });
  });
}

export async function runDeploy(
  _argv: string[],
  options: DeployOptions = {},
): Promise<void> {
  const json = options.json ?? false;

  // -------------------------------------------------------------------------
  // Step 1: Validate flags
  // -------------------------------------------------------------------------
  if (options.noSetup && !options.authToken) {
    process.stderr.write(
      "Error: --no-setup requires --auth-token.\n\n" +
        "Fix:\n" +
        "  npx 3amoncall deploy --no-setup --auth-token <token>\n",
    );
    process.exit(1);
    return;
  }

  if (options.noInteractive && (!options.yes || !options.platform)) {
    process.stderr.write(
      "Error: --no-interactive requires --yes and an explicit deploy target.\n\n" +
        "Fix:\n" +
        "  npx 3amoncall deploy vercel --no-interactive --yes\n",
    );
    process.exit(1);
    return;
  }

  // -------------------------------------------------------------------------
  // Step 2: Resolve API key
  // -------------------------------------------------------------------------
  const apiKey = await resolveApiKey({ noInteractive: options.noInteractive });
  if (!apiKey) {
    process.stderr.write(
      "Error: ANTHROPIC_API_KEY is required to deploy.\n\n" +
        "Fix:\n" +
        "  npx 3amoncall init --api-key <your-key>\n" +
        "  npx 3amoncall deploy\n",
    );
    process.exit(1);
    return;
  }

  // -------------------------------------------------------------------------
  // Step 3: Platform selection
  // -------------------------------------------------------------------------
  let platform: Platform;
  if (options.platform) {
    platform = options.platform;
  } else if (options.noInteractive) {
    process.stderr.write(
      "Error: --no-interactive requires an explicit deploy target.\n\n" +
        "Fix:\n" +
        "  npx 3amoncall deploy vercel --no-interactive --yes\n",
    );
    process.exit(1);
    return;
  } else {
    platform = await promptPlatformSelection();
  }

  // -------------------------------------------------------------------------
  // Step 4: Detect platform CLI
  // -------------------------------------------------------------------------
  const cliInstalled = detectPlatformCli(platform);
  if (!cliInstalled) {
    const installCmd =
      platform === "vercel" ? "npm i -g vercel" : "npm i -g wrangler";
    const binaryName = platform === "vercel" ? "vercel" : "wrangler";
    process.stderr.write(
      `Error: ${binaryName} CLI is not installed.\n\n` +
        "Fix:\n" +
        `  ${installCmd}\n` +
        `  npx 3amoncall deploy\n`,
    );
    process.exit(1);
    return;
  }

  // -------------------------------------------------------------------------
  // Step 5: Check platform auth
  // -------------------------------------------------------------------------
  const authed = await checkPlatformAuth(platform);
  if (!authed) {
    const loginCmd =
      platform === "vercel" ? "vercel login" : "wrangler login";
    const binaryName = platform === "vercel" ? "vercel" : "wrangler";
    process.stderr.write(
      `Error: not logged in to ${binaryName}.\n\n` +
        "Fix:\n" +
        `  ${loginCmd}\n` +
        `  npx 3amoncall deploy\n`,
    );
    process.exit(1);
    return;
  }

  // -------------------------------------------------------------------------
  // Step 6: Confirm deploy
  // -------------------------------------------------------------------------
  if (!options.yes) {
    const confirmed = await promptConfirm(
      `Deploy Receiver to ${platform}? [Y/n] `,
    );
    if (!confirmed) {
      info("Deploy cancelled.\n", json);
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Step 7: Provision and deploy Receiver
  // -------------------------------------------------------------------------
  info(`\nDeploying Receiver to ${platform}...\n`, json);
  const provider = createProvider(platform, {
    projectName: options.projectName,
  });
  let deployedUrl: string;
  try {
    // Set ANTHROPIC_API_KEY on the platform before deploying
    info("Setting ANTHROPIC_API_KEY on platform...\n", json);
    await provider.setEnvVar("ANTHROPIC_API_KEY", apiKey);

    const result = await provider.deploy();
    deployedUrl = result.url;
  } catch (err) {
    provider.cleanup();
    process.stderr.write(
      `Error: deploy failed: ${String(err)}\n\n` +
        "Fix:\n" +
        `  Check the output above for ${platform === "vercel" ? "Vercel" : "Cloudflare"} error details.\n`,
    );
    process.exit(1);
    return;
  } finally {
    provider.cleanup();
  }

  info(`\nReceiver deployed: ${deployedUrl}\n`, json);

  // -------------------------------------------------------------------------
  // Step 8: Wait for Receiver readiness
  // -------------------------------------------------------------------------
  info("\nWaiting for Receiver to become ready...\n", json);
  const ready = await waitForReceiver(deployedUrl, 60_000);
  if (!ready) {
    info(
      "Warning: Receiver did not become ready within 60s. Continuing anyway.\n" +
        "  The Receiver may still be starting up. If the .env update fails,\n" +
        "  wait a moment and re-run: npx 3amoncall deploy --no-setup --auth-token <token>\n",
      json,
    );
  } else {
    info("Receiver is ready.\n", json);
  }

  // -------------------------------------------------------------------------
  // Step 9: Get AUTH_TOKEN
  // -------------------------------------------------------------------------
  let authToken: string;

  if (options.authToken) {
    // --auth-token flag takes priority (covers --no-setup case too)
    authToken = options.authToken;
  } else if (options.noSetup) {
    // Validated in step 1: --no-setup without --auth-token is already blocked
    // This branch is unreachable, but TypeScript needs it
    process.stderr.write(
      "Error: --no-setup requires --auth-token.\n\n" +
        "Fix:\n" +
        "  npx 3amoncall deploy --no-setup --auth-token <token>\n",
    );
    process.exit(1);
    return;
  } else {
    // --setup or auto-detect via setup token API
    info("\nFetching setup token...\n", json);
    const setupResult = await fetchSetupToken(deployedUrl);

    if (setupResult.status === "token") {
      authToken = setupResult.token;
      info("Setup token obtained.\n", json);
    } else if (setupResult.status === "already-setup") {
      info(
        "Receiver is already configured (setup token already consumed).\n",
        json,
      );
      if (options.noInteractive) {
        process.stderr.write(
          "Error: Receiver already set up and no --auth-token provided.\n\n" +
            "Fix:\n" +
            "  npx 3amoncall deploy --no-setup --auth-token <token>\n",
        );
        process.exit(1);
        return;
      }
      authToken = await promptAuthToken();
    } else {
      // status === "error"
      info(
        `Warning: could not fetch setup token: ${setupResult.message}\n`,
        json,
      );
      if (options.noInteractive) {
        process.stderr.write(
          "Error: could not obtain auth token and running in non-interactive mode.\n\n" +
            "Fix:\n" +
            "  npx 3amoncall deploy --no-setup --auth-token <token>\n",
        );
        process.exit(1);
        return;
      }
      authToken = await promptAuthToken();
    }
  }

  // -------------------------------------------------------------------------
  // Step 10: Update .env
  // -------------------------------------------------------------------------

  // Preview changes
  const preview = updateAppEnv({
    receiverUrl: deployedUrl,
    authToken,
    dryRun: true,
  });

  info("\nPlanned .env changes:\n", json);
  if (preview.added.length > 0) {
    info(`  Added:   ${preview.added.join(", ")}\n`, json);
  }
  if (preview.updated.length > 0) {
    info(`  Updated: ${preview.updated.join(", ")}\n`, json);
  }
  if (preview.added.length === 0 && preview.updated.length === 0) {
    info("  (no changes — values already up to date)\n", json);
  }
  info(`  File:    ${preview.envPath}\n`, json);

  let envUpdated = false;
  let finalEnvPath = preview.envPath;

  if (!options.yes) {
    const confirmEnv = await promptConfirm(
      "\nUpdate .env with these values? [Y/n] ",
    );
    if (!confirmEnv) {
      info("\nSkipped .env update. To configure manually:\n", json);
      info(`  OTEL_EXPORTER_OTLP_ENDPOINT=${deployedUrl}\n`, json);
      info(
        `  OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${authToken}\n\n`,
        json,
      );
    } else {
      const result = updateAppEnv({ receiverUrl: deployedUrl, authToken });
      envUpdated = true;
      finalEnvPath = result.envPath;
      info(`\n.env updated at ${finalEnvPath}\n`, json);
    }
  } else {
    const result = updateAppEnv({ receiverUrl: deployedUrl, authToken });
    envUpdated = true;
    finalEnvPath = result.envPath;
    info(`\n.env updated at ${finalEnvPath}\n`, json);
  }

  // -------------------------------------------------------------------------
  // Step 11: Completion output
  // -------------------------------------------------------------------------
  const consoleUrl = deployedUrl;

  if (json) {
    const output = JSON.stringify(
      {
        status: "deployed",
        receiverUrl: deployedUrl,
        consoleUrl,
        authToken,
        envUpdated,
        envPath: finalEnvPath,
      },
      null,
      2,
    );
    process.stdout.write(output + "\n");
  } else {
    process.stdout.write("\nDeploy complete!\n\n");
    process.stdout.write(`  Receiver URL: ${deployedUrl}\n`);
    process.stdout.write(`  Console URL:  ${consoleUrl}\n\n`);
    process.stdout.write("Next steps:\n");
    if (!envUpdated) {
      process.stdout.write("  1. Add to your app's .env:\n");
      process.stdout.write(
        `       OTEL_EXPORTER_OTLP_ENDPOINT=${deployedUrl}\n`,
      );
      process.stdout.write(
        `       OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${authToken}\n`,
      );
      process.stdout.write("  2. Restart your app\n");
      process.stdout.write(`  3. Open ${consoleUrl} to view incidents\n`);
    } else {
      process.stdout.write("  1. Restart your app to pick up the new .env\n");
      process.stdout.write(`  2. Open ${consoleUrl} to view incidents\n`);
    }
    process.stdout.write("\n");
  }
}
