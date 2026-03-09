// DEV/PREVIEW CONVENIENCE ONLY — NOT PRODUCTION-READY
// VITE_RECEIVER_AUTH_TOKEN is embedded in the client bundle at build time.
// Anyone with the bundle can extract the token. This is acceptable for
// local development and preview deployments only.
// Phase E will replace this with a BFF / same-origin proxy so the token
// never leaves the server. Do NOT use this pattern in production.

const AUTH_TOKEN = import.meta.env["VITE_RECEIVER_AUTH_TOKEN"] as string | undefined;

export async function apiFetch<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
  }
  const res = await fetch(path, { headers });
  if (!res.ok) {
    throw new ApiError(res.status, await res.text());
  }
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
