export interface WebhookResult {
  ok: boolean;
  status?: number;
  error?: string;
}

async function attemptPost(url: string, body: unknown, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export async function sendWebhook(url: string, body: unknown): Promise<WebhookResult> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = "(invalid url)";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    let response: Response;
    try {
      response = await attemptPost(url, body, controller.signal);
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[sendWebhook] request failed host=${hostname}:`, message);
      return { ok: false, error: message };
    }

    // 2xx success
    if (response.ok) {
      clearTimeout(timer);
      return { ok: true, status: response.status };
    }

    // 4xx — no retry
    if (response.status >= 400 && response.status < 500) {
      clearTimeout(timer);
      console.warn(`[sendWebhook] client error host=${hostname} status=${response.status}`);
      return { ok: false, status: response.status, error: "client error" };
    }

    // 5xx — retry once
    let retryResponse: Response;
    try {
      retryResponse = await attemptPost(url, body, controller.signal);
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[sendWebhook] retry failed host=${hostname}:`, message);
      return { ok: false, error: message };
    }

    clearTimeout(timer);

    if (retryResponse.ok) {
      return { ok: true, status: retryResponse.status };
    }

    console.warn(
      `[sendWebhook] server error after retry host=${hostname} status=${retryResponse.status}`
    );
    return {
      ok: false,
      status: retryResponse.status,
      error: "server error after retry",
    };
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[sendWebhook] unexpected error host=${hostname}:`, message);
    return { ok: false, error: message };
  }
}
