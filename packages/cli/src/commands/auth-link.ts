import { buildClaimUrl, createClaimTokenWithRetry } from "./shared/health.js";
import {
  findReceiverCredentialByUrl,
  loadCredentials,
} from "./init/credentials.js";

export async function runAuthLink(options: {
  receiverUrl?: string;
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

  const matched = findReceiverCredentialByUrl(creds, receiverUrl);
  const authToken = matched?.authToken ?? creds.receiverAuthToken;
  if (!authToken) {
    process.stderr.write(
      "Error: no stored receiver credentials found for that URL.\n\n" +
        "Fix:\n" +
        "  Re-run `npx 3am deploy` from the machine that manages this receiver.\n",
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
