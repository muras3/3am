import { buildClaimUrl, createClaimTokenWithRetry } from "./shared/health.js";
import {
  findReceiverCredentialByUrl,
  loadCredentials,
} from "./init/credentials.js";

export async function runAuthLink(options: {
  receiverUrl?: string;
  /** Explicit auth token override — bypasses credential lookup entirely. */
  authToken?: string;
  json?: boolean;
} = {}): Promise<void> {
  const json = options.json ?? false;
  const creds = loadCredentials();
  const receiverUrl = options.receiverUrl ?? creds.receiverUrl;

  if (!receiverUrl) {
    process.stderr.write(
      "Error: receiver URL is required.\n\n" +
        "Fix:\n" +
        "  npx 3am auth-link <receiver-url>\n",
    );
    process.exit(1);
    return;
  }

  let authToken: string | undefined;

  if (options.authToken) {
    // Explicit --auth-token flag takes highest priority
    authToken = options.authToken;
  } else if (options.receiverUrl) {
    // URL was explicitly passed — require a URL match from the receivers map.
    // Do NOT fall through to receiverAuthToken (which may belong to a
    // different platform receiver, causing a silent 401).
    const matched = findReceiverCredentialByUrl(creds, options.receiverUrl);
    if (matched?.authToken) {
      authToken = matched.authToken;
    } else {
      // No match — build a helpful error listing available receivers
      const available = Object.entries(creds.receivers ?? {})
        .filter(([, v]) => v?.url && v.authToken)
        .map(([platform, v]) => `  ${platform}: ${v!.url}`);
      process.stderr.write(
        `Error: no stored credentials found for ${options.receiverUrl}.\n\n`,
      );
      if (available.length > 0) {
        process.stderr.write(
          "Available receivers:\n" + available.join("\n") + "\n\n" +
          "Fix:\n" +
          "  npx 3am auth-link <receiver-url>           # use a stored receiver\n" +
          "  npx 3am auth-link <url> --auth-token <t>   # explicit token override\n",
        );
      } else {
        process.stderr.write(
          "Fix:\n" +
          "  Re-run `npx 3am deploy` from the machine that manages this receiver.\n" +
          "  Or pass --auth-token explicitly:\n" +
          "    npx 3am auth-link <url> --auth-token <token>\n",
        );
      }
      process.exit(1);
      return;
    }
  } else {
    // No explicit URL — use default receiver (single-receiver fallback is safe here)
    const matched = findReceiverCredentialByUrl(creds, receiverUrl);
    authToken = matched?.authToken ?? creds.receiverAuthToken;
  }

  if (!authToken) {
    process.stderr.write(
      "Error: no stored receiver credentials found.\n\n" +
        "Fix:\n" +
        "  Re-run `npx 3am deploy` from the machine that manages this receiver.\n" +
        "  Or pass --auth-token explicitly:\n" +
        "    npx 3am auth-link <url> --auth-token <token>\n",
    );
    process.exit(1);
    return;
  }

  const result = await createClaimTokenWithRetry(receiverUrl, authToken, 5);
  if (result.status === "error") {
    process.stderr.write(
      `Error: could not mint sign-in link: ${result.message}\n`,
    );
    process.exit(1);
    return;
  }

  const claimUrl = buildClaimUrl(receiverUrl, result.token);
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          receiverUrl,
          claimUrl,
          expiresAt: result.expiresAt,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  process.stdout.write("Open this sign-in URL in your browser:\n");
  process.stdout.write(`${claimUrl}\n`);
  process.stdout.write(`Expires at: ${result.expiresAt}\n`);
}
