const STORAGE_KEY = "receiver_auth_token";

/** Event name dispatched on window when the API returns 401/403. */
export const AUTH_FAILURE_EVENT = "3amoncall:auth-failure";

function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem(STORAGE_KEY);
  if (token) {
    return { "Content-Type": "application/json", "Authorization": `Bearer ${token}` };
  }
  return { "Content-Type": "application/json" };
}

function userMessage(status: number): string {
  if (status === 404) return "Not found.";
  if (status === 401 || status === 403) return "Unauthorized.";
  if (status >= 500) return "Server error. Please try again.";
  return `Request failed (${status}).`;
}

/**
 * Clear stored token and notify SetupGate to show recovery screen.
 * Only clears if the current token matches the one that was used for the
 * failed request — prevents stale in-flight 401s from clobbering a
 * newly-entered valid token.
 */
function handleAuthFailure(usedToken: string | null): void {
  const currentToken = localStorage.getItem(STORAGE_KEY);
  if (currentToken !== usedToken) return; // token was already replaced
  localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new CustomEvent(AUTH_FAILURE_EVENT));
}

export function saveAuthToken(token: string): void {
  localStorage.setItem(STORAGE_KEY, token);
}

export function getStoredAuthToken(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export async function apiFetchPost<T>(path: string, body: unknown): Promise<T> {
  const tokenAtCallTime = localStorage.getItem(STORAGE_KEY);
  const res = await fetch(path, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const rawBody = await res.text();
    if (import.meta.env.DEV) {
      console.error(`[apiFetch] POST ${res.status} ${path}:`, rawBody);
    }
    if (res.status === 401 || res.status === 403) {
      handleAuthFailure(tokenAtCallTime);
    }
    throw new ApiError(res.status, rawBody);
  }
  return res.json() as Promise<T>;
}

export async function apiFetch<T>(path: string): Promise<T> {
  const tokenAtCallTime = localStorage.getItem(STORAGE_KEY);
  const res = await fetch(path, {
    headers: getAuthHeaders(),
  });
  if (!res.ok) {
    const rawBody = await res.text();
    if (import.meta.env.DEV) {
      console.error(`[apiFetch] ${res.status} ${path}:`, rawBody);
    }
    if (res.status === 401 || res.status === 403) {
      handleAuthFailure(tokenAtCallTime);
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
