/**
 * Shared health-check and bootstrap-link utilities for CLI commands.
 */

export type ClaimTokenResult =
  | { status: "ok"; token: string; expiresAt: string }
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
 * Ask the receiver to mint a short-lived one-time claim token.
 */
export async function createClaimToken(
  baseUrl: string,
  authToken: string,
): Promise<ClaimTokenResult> {
  try {
    const res = await fetch(`${baseUrl}/api/claims`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`,
      },
      body: "{}",
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      const retryable = res.status === 401 || res.status === 503;
      return {
        status: "error",
        message: `claims returned ${res.status}`,
        retryable,
      };
    }

    const data = (await res.json()) as { token?: string; expiresAt?: string };
    if (!data.token || !data.expiresAt) {
      return {
        status: "error",
        message: "claims response missing token or expiresAt",
      };
    }
    return { status: "ok", token: data.token, expiresAt: data.expiresAt };
  } catch (err) {
    return {
      status: "error",
      message: `failed to reach claims endpoint: ${String(err)}`,
      retryable: true,
    };
  }
}

/**
 * Retry `createClaimToken` with exponential backoff.
 */
export async function createClaimTokenWithRetry(
  baseUrl: string,
  authToken: string,
  maxRetries = 5,
  onRetry?: (attempt: number, maxRetries: number, delayMs: number, message: string) => void,
): Promise<ClaimTokenResult> {
  const effectiveRetries = Math.max(1, maxRetries);
  let result: ClaimTokenResult | null = null;

  for (let attempt = 0; attempt < effectiveRetries; attempt++) {
    result = await createClaimToken(baseUrl, authToken);
    if (result.status !== "error") return result;
    if (!result.retryable) return result;
    if (attempt === effectiveRetries - 1) break;

    const delay = Math.min(3_000 * Math.pow(2, attempt), 15_000);
    onRetry?.(attempt + 1, effectiveRetries, delay, result.message);
    await new Promise((r) => setTimeout(r, delay));
  }

  return result!;
}

export function buildClaimUrl(baseUrl: string, claimToken: string): string {
  const url = new URL(baseUrl);
  url.hash = `claim=${encodeURIComponent(claimToken)}`;
  return url.toString();
}
