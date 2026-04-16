/**
 * `npx 3am deploy` — deploy the Receiver to Vercel or Cloudflare,
 * then wire up the app's .env with the deployed URL and auth token.
 *
 * Orchestration flow:
 *  1. Validate flags
 *  2. Resolve ANTHROPIC_API_KEY
 *  3. Platform selection
 *  4. Detect platform CLI
 *  5. Check platform auth
 *  6. Confirm deploy
 *  7. Resolve auth token (CLI credentials or generate)
 *  8. Set platform secrets + deploy
 *  9. Wait for Receiver readiness
 *  9b. Verify Receiver initialisation and mint a sign-in link
 * 10. Connect app runtime (CF Worker config / .env update)
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
import { updateAppEnv } from "./deploy/env-writer.js";
import {
  waitForReceiver,
  createClaimTokenWithRetry,
  buildClaimUrl,
} from "./shared/health.js";
import {
  resolveApiKey,
  loadCredentials,
  saveCredentials,
  getReceiverCredential,
  setReceiverCredential,
} from "./init/credentials.js";
import { connectCloudflareWorkerToReceiver } from "./cloudflare-workers.js";
import { randomUUID } from "node:crypto";

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
  /**
   * --account-id: Cloudflare account ID override.
   * Required when using a scoped CF API token (prefix `cfut_`) that lacks
   * Account:Read / User Details:Read.  Falls back to the CLOUDFLARE_ACCOUNT_ID
   * or CF_ACCOUNT_ID environment variables when not provided.
   */
  accountId?: string;
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

const SUPPORTED_DEPLOY_LOCALES = ["en", "ja"] as const;

/**
 * Sync the locale stored in CLI credentials to the receiver.
 * Best-effort: failures produce a warning but do not abort deploy.
 */
async function syncLocaleToReceiver(
  receiverUrl: string,
  locale: string | undefined,
  json: boolean,
): Promise<void> {
  if (!locale) return;

  if (!(SUPPORTED_DEPLOY_LOCALES as readonly string[]).includes(locale)) {
    info(
      `Warning: locale "${locale}" is not supported (must be one of: ${SUPPORTED_DEPLOY_LOCALES.join(", ")}). Skipping locale sync.\n`,
      json,
    );
    return;
  }

  try {
    const res = await fetch(`${receiverUrl}/api/settings/locale`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale }),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 404 || res.status === 405) {
      // Older receiver versions without this endpoint — skip silently.
      return;
    }
    if (!res.ok) {
      info(
        `Warning: locale sync failed (HTTP ${res.status}). Diagnosis output may appear in English.\n`,
        json,
      );
    } else {
      info(`Locale synced to receiver: ${locale}.\n`, json);
    }
  } catch (err) {
    info(
      `Warning: locale sync failed (${String(err)}). Diagnosis output may appear in English.\n`,
      json,
    );
  }
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
        "  npx 3am deploy --no-setup --auth-token <token>\n",
    );
    process.exit(1);
    return;
  }

  if (options.noInteractive && (!options.yes || !options.platform)) {
    process.stderr.write(
      "Error: --no-interactive requires --yes and an explicit deploy target.\n\n" +
        "Fix:\n" +
        "  npx 3am deploy vercel --no-interactive --yes\n",
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
        "  npx 3am init --api-key <your-key>\n" +
        "  npx 3am deploy\n",
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
        "  npx 3am deploy vercel --no-interactive --yes\n",
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
        `  npx 3am deploy\n`,
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
        `  npx 3am deploy\n`,
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
  // Step 7: Resolve auth token (CLI-managed, stable across re-deploys)
  // -------------------------------------------------------------------------
  let authToken: string;

  if (options.authToken) {
    // --auth-token flag takes highest priority
    authToken = options.authToken;
  } else {
    // Load from CLI credentials or generate new
    const creds = loadCredentials();
    const existingReceiver = getReceiverCredential(creds, platform);
    if (existingReceiver?.authToken) {
      authToken = existingReceiver.authToken;
      info("Using existing auth token from CLI credentials.\n", json);
    } else {
      authToken = randomUUID();
      info("Generated new auth token.\n", json);
    }
  }

  // Persist to CLI credentials (idempotent)
  const existingCreds = loadCredentials();
  const llmMode = existingCreds.llmMode;
  const llmProvider = existingCreds.llmProvider;
  const llmBridgeUrl = existingCreds.llmBridgeUrl;

  // -------------------------------------------------------------------------
  // Step 8: Provision and deploy Receiver
  // -------------------------------------------------------------------------
  info(`\nDeploying Receiver to ${platform}...\n`, json);
  const provider = createProvider(platform, {
    projectName: options.projectName,
    accountId: options.accountId,
  });
  let deployedUrl: string;
  let claimUrl: string | undefined;
  try {
    // Set secrets on the platform before deploying
    info("Setting ANTHROPIC_API_KEY on platform...\n", json);
    await provider.setEnvVar("ANTHROPIC_API_KEY", apiKey);
    info("Setting RECEIVER_AUTH_TOKEN on platform...\n", json);
    await provider.setEnvVar("RECEIVER_AUTH_TOKEN", authToken);
    if (llmMode) {
      info("Setting LLM_MODE on platform...\n", json);
      await provider.setEnvVar("LLM_MODE", llmMode);
    }
    if (llmProvider) {
      info("Setting LLM_PROVIDER on platform...\n", json);
      await provider.setEnvVar("LLM_PROVIDER", llmProvider);
    }
    if (llmBridgeUrl) {
      info("Setting LLM_BRIDGE_URL on platform...\n", json);
      await provider.setEnvVar("LLM_BRIDGE_URL", llmBridgeUrl);
    }

    const result = await provider.deploy();
    deployedUrl = result.url;

    // Set CONSOLE_BASE_URL so notification claim links point to the deployed receiver
    info("Setting CONSOLE_BASE_URL on platform...\n", json);
    await provider.setEnvVar("CONSOLE_BASE_URL", deployedUrl);
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
  saveCredentials(setReceiverCredential(loadCredentials(), platform, {
    url: deployedUrl,
    authToken,
  }));

  // -------------------------------------------------------------------------
  // Step 9: Wait for Receiver readiness
  // -------------------------------------------------------------------------
  info("\nWaiting for Receiver to become ready...\n", json);
  const ready = await waitForReceiver(deployedUrl, 60_000);
  if (!ready) {
    info(
      "Warning: Receiver did not become ready within 60s. Continuing anyway.\n" +
        "  The Receiver may still be starting up. If the .env update fails,\n" +
        "  wait a moment and re-run: npx 3am deploy --no-setup --auth-token <token>\n",
      json,
    );
  } else {
    info("Receiver is ready.\n", json);
  }

  // -------------------------------------------------------------------------
  // Step 9b: Verify Receiver initialisation and mint a secure sign-in link
  // -------------------------------------------------------------------------
  info("\nMinting secure sign-in link...\n", json);
  const claimResult = await createClaimTokenWithRetry(
    deployedUrl,
    authToken,
    5,
    (attempt, max, delayMs, message) => {
      info(
        `  Receiver not ready (${message}), retrying in ${delayMs / 1000}s... (${attempt}/${max})\n`,
        json,
      );
    },
  );

  if (claimResult.status === "error") {
    info(
      `Warning: could not mint sign-in link: ${claimResult.message}\n` +
        "  The Receiver may still be initialising. You can generate a fresh link later with:\n" +
        `  npx 3am auth-link ${deployedUrl}\n`,
      json,
    );
  } else {
    claimUrl = buildClaimUrl(deployedUrl, claimResult.token);
    info("Receiver initialisation verified.\n", json);
  }

  // -------------------------------------------------------------------------
  // Step 9c: Sync locale to receiver (best-effort)
  // -------------------------------------------------------------------------
  await syncLocaleToReceiver(deployedUrl, loadCredentials().locale, json);

  // -------------------------------------------------------------------------
  // Step 10: Connect the app runtime
  // -------------------------------------------------------------------------
  if (platform === "cloudflare") {
    info("\nConfiguring Cloudflare Worker telemetry export...\n", json);
    let state;
    try {
      state = await connectCloudflareWorkerToReceiver(process.cwd(), deployedUrl, authToken, {
        noInteractive: options.noInteractive,
        accountId: options.accountId,
      });
    } catch (err) {
      const errMsg = String(err);
      const isAuthError = /401|403|unauthorized|forbidden|authentication/i.test(errMsg);
      process.stderr.write(
        `Error: failed to configure Cloudflare telemetry export: ${errMsg}\n\n`,
      );
      if (isAuthError) {
        process.stderr.write(
          "Fix: your Cloudflare API token lacks the required permissions.\n" +
          "  Create a token at https://dash.cloudflare.com/profile/api-tokens with:\n" +
          "    Account Settings:Read, Workers Scripts:Edit, D1:Edit,\n" +
          "    Cloudflare Queues:Edit, Workers Observability:Edit\n" +
          "  Then export CLOUDFLARE_API_TOKEN and re-run:\n" +
          "    npx 3am deploy cloudflare --yes\n",
        );
      } else {
        process.stderr.write(
          "Fix: this may be a transient Cloudflare API error (the deploy retried automatically).\n" +
          "  Re-run the deploy — your existing secrets and Worker are still in place:\n" +
          "    npx 3am deploy cloudflare --yes\n",
        );
      }
      process.exit(1);
      return;
    }

    if (json) {
      const output = JSON.stringify(
        {
          status: "deployed",
          receiverUrl: deployedUrl,
          consoleUrl: deployedUrl,
          claimUrl,
          authToken,
          workerName: state.workerName,
          wranglerConfigPath: state.configPath,
          wranglerUpdated: state.changed,
        },
        null,
        2,
      );
      process.stdout.write(output + "\n");
      return;
    }

    process.stdout.write("\nDeploy complete!\n\n");
    process.stdout.write(`  Receiver URL: ${deployedUrl}\n`);
    process.stdout.write(`  Console URL:  ${deployedUrl}\n`);
    if (claimUrl) process.stdout.write(`  Sign-in URL:  ${claimUrl}\n`);
    process.stdout.write(`  Worker:       ${state.workerName}\n`);
    process.stdout.write(`  Wrangler:     ${state.configPath}\n\n`);
    process.stdout.write("Next steps:\n");
    process.stdout.write("  1. Trigger requests against your Cloudflare Worker\n");
    process.stdout.write(`  2. Open ${claimUrl ?? deployedUrl}\n`);
    process.stdout.write("  3. Run `npx 3am integrations notifications` to connect Slack/Discord\n");
    process.stdout.write("  4. Generate a fresh sign-in link any time with `npx 3am auth-link`\n\n");
    return;
  }

  // -------------------------------------------------------------------------
  // Step 11: Update .env
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
  // Step 12: Completion output
  // -------------------------------------------------------------------------
  const consoleUrl = deployedUrl;

  if (json) {
    const output = JSON.stringify(
      {
        status: "deployed",
        receiverUrl: deployedUrl,
        consoleUrl,
        claimUrl,
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
    process.stdout.write(`  Console URL:  ${consoleUrl}\n`);
    if (claimUrl) process.stdout.write(`  Sign-in URL:  ${claimUrl}\n`);
    process.stdout.write("\n");
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
      process.stdout.write(`  3. Open ${claimUrl ?? consoleUrl}\n`);
      process.stdout.write("  4. Run `npx 3am integrations notifications`\n");
    } else {
      process.stdout.write("  1. Restart your app to pick up the new .env\n");
      process.stdout.write(`  2. Open ${claimUrl ?? consoleUrl}\n`);
      process.stdout.write("  3. Run `npx 3am integrations notifications`\n");
    }
    process.stdout.write("  Use `npx 3am auth-link` from a trusted machine to mint a fresh sign-in link later\n\n");
  }
}
