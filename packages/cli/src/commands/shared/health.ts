/**
 * Shared health-check and setup utilities for CLI commands (demo, deploy).
 */

export type SetupTokenResult =
  | { status: "token"; token: string }
  | { status: "already-setup" }
  | { status: "error"; message: string; retryable?: boolean };

/**
 * Check whether the Receiver is reachable and responding.
 * Hits `GET /healthz` (no auth required) with a 5-second timeout.
 */
export async function checkReceiver(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/healthz`, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Poll `checkReceiver` until it returns true or `timeoutMs` elapses.
 *
 * Intended for post-deploy warm-up: Vercel / CF cold-start can take 10-30s.
 *
 * @param url        Receiver base URL
 * @param timeoutMs  Maximum total wait time in ms
 * @param intervalMs Polling interval in ms (default 3000)
 * @returns `true` when the Receiver is healthy, `false` on timeout
 */
export async function waitForReceiver(
  url: string,
  timeoutMs: number,
  intervalMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const healthy = await checkReceiver(url);
    if (healthy) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
  }
  return false;
}

/**
 * Fetch the one-time setup token from the Receiver's setup-token API.
 *
 * Flow:
 * 1. GET /api/setup-status
 *    - `{ setupComplete: false }` → proceed to fetch the token
 *    - `{ setupComplete: true }`  → return `{ status: "already-setup" }`
 *    - error                      → return `{ status: "error", message }`
 * 2. GET /api/setup-token
 *    - 200 with `{ token }` → return `{ status: "token", token }`
 *    - 403               → return `{ status: "already-setup" }` (race condition)
 *    - error             → return `{ status: "error", message }`
 */
export async function fetchSetupToken(
  baseUrl: string,
): Promise<SetupTokenResult> {
  // Step 1: check setup status
  let setupComplete: boolean;
  try {
    const res = await fetch(`${baseUrl}/api/setup-status`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      // 401/503 typically mean DB migration hasn't completed yet —
      // the HTTP server is up (healthz passes) but the app layer
      // isn't fully initialised. Mark these as retryable so the
      // caller can back off and retry.
      const retryable = res.status === 401 || res.status === 503;
      return {
        status: "error",
        message: `setup-status returned ${res.status}`,
        retryable,
      };
    }
    const data = (await res.json()) as { setupComplete?: boolean };
    setupComplete = data.setupComplete === true;
  } catch (err) {
    return {
      status: "error",
      message: `failed to reach setup-status: ${String(err)}`,
      retryable: true,
    };
  }

  if (setupComplete) {
    return { status: "already-setup" };
  }

  // Step 2: fetch the setup token
  try {
    const res = await fetch(`${baseUrl}/api/setup-token`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 403) {
      // Race condition — another client already consumed the token
      return { status: "already-setup" };
    }
    if (!res.ok) {
      return {
        status: "error",
        message: `setup-token returned ${res.status}`,
      };
    }
    const data = (await res.json()) as { token?: string };
    if (!data.token) {
      return {
        status: "error",
        message: "setup-token response missing token field",
      };
    }
    return { status: "token", token: data.token };
  } catch (err) {
    return {
      status: "error",
      message: `failed to reach setup-token: ${String(err)}`,
    };
  }
}

/**
 * Retry `fetchSetupToken` with exponential backoff.
 *
 * After a fresh deploy the HTTP server may be up (healthz 200) while DB
 * migrations are still running, causing setup-status to return 401 or 503.
 * This wrapper retries on retryable errors so the deploy command can
 * reliably obtain the setup token without manual intervention.
 *
 * @param baseUrl      Receiver base URL
 * @param maxRetries   Maximum number of attempts (default 5)
 * @param onRetry      Optional callback for logging retry progress
 * @returns The final `SetupTokenResult` after retries are exhausted
 */
export async function fetchSetupTokenWithRetry(
  baseUrl: string,
  maxRetries = 5,
  onRetry?: (attempt: number, maxRetries: number, delayMs: number, message: string) => void,
): Promise<SetupTokenResult> {
  let result: SetupTokenResult | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    result = await fetchSetupToken(baseUrl);

    // Success or non-retryable result — stop immediately
    if (result.status !== "error") return result;
    if (!result.retryable) return result;

    // Last attempt — don't sleep, just return the error
    if (attempt === maxRetries - 1) break;

    const delay = Math.min(3_000 * Math.pow(2, attempt), 15_000);
    onRetry?.(attempt + 1, maxRetries, delay, result.message);
    await new Promise((r) => setTimeout(r, delay));
  }

  return result!;
}
