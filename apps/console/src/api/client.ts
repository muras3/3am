// DEV/PREVIEW CONVENIENCE ONLY — NOT PRODUCTION-READY
// VITE_RECEIVER_AUTH_TOKEN is embedded in the client bundle at build time.
// Anyone with the bundle can extract the token. This is acceptable for
// local development and preview deployments only.
// Phase E will replace this with a BFF / same-origin proxy so the token
// never leaves the server. Do NOT use this pattern in production.

const AUTH_TOKEN = import.meta.env["VITE_RECEIVER_AUTH_TOKEN"] as string | undefined;

function userMessage(status: number): string {
  if (status === 404) return "Not found.";
  if (status === 401 || status === 403) return "Unauthorized.";
  if (status >= 500) return "Server error. Please try again.";
  return `Request failed (${status}).`;
}

export async function apiFetchPost<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
  }
  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const rawBody = await res.text();
    if (import.meta.env.DEV) {
      console.error(`[apiFetch] POST ${res.status} ${path}:`, rawBody);
    }
    throw new ApiError(res.status, rawBody);
  }
  return res.json() as Promise<T>;
}

export async function apiFetch<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
  }
  const res = await fetch(path, { headers });
  if (!res.ok) {
    const rawBody = await res.text();
    if (import.meta.env.DEV) {
      console.error(`[apiFetch] ${res.status} ${path}:`, rawBody);
    }
    throw new ApiError(res.status, rawBody);
  }
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  /** Raw response body — for dev debugging only, never show to end users. */
  readonly rawBody: string;
  constructor(
    public readonly status: number,
    rawBody: string,
  ) {
    super(userMessage(status));
    this.rawBody = rawBody;
    this.name = "ApiError";
  }
}
