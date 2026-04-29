// rest.ts — REST client that talks to the SVP server directly from the
// encryptor's React side. Uses the Tauri `get_api_auth` command to fetch
// the current bearer token + server base URL on every call (so when the
// access token rotates after a refresh, we always use the latest).
//
// Same trust model as a browser-tab admin dashboard with a bearer token in
// localStorage — we accept that the JS side can read the token, since
// adding 30+ Tauri command wrappers around every admin endpoint would be
// pure boilerplate.

import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

interface ApiAuth {
  server_url: string;
  access_token: string | null;
}

// Routes through the Tauri HTTP plugin (Rust reqwest), which bypasses the
// WebView's CSP / CORS — those would otherwise block calls from
// https://tauri.localhost (the production WebView origin) to api.allentics.com.
async function authedFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const auth = await invoke<ApiAuth>("get_api_auth");
  if (!auth.access_token) {
    throw new Error("Not authenticated");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.access_token}`,
    ...(init.headers as Record<string, string>),
  };
  if (init.body && !(init.body instanceof FormData)) {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
  }
  return tauriFetch(`${auth.server_url}${path}`, { ...init, headers });
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await authedFetch(path);
  if (!res.ok) throw await toError(res);
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await authedFetch(path, {
    method: "POST",
    body: body !== undefined ? JSON.stringify(body) : "{}",
  });
  if (!res.ok) throw await toError(res);
  return res.json() as Promise<T>;
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await authedFetch(path, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toError(res);
  return res.json() as Promise<T>;
}

export async function apiDelete(path: string): Promise<void> {
  const res = await authedFetch(path, { method: "DELETE" });
  if (!res.ok) throw await toError(res);
}

/** Escape hatch for endpoints that take FormData (e.g. /admin/students POST).
 *  Same auth + error handling as apiPost, but skips the JSON.stringify step.
 */
export async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  const res = await authedFetch(path, { method: "POST", body: form });
  if (!res.ok) throw await toError(res);
  return res.json() as Promise<T>;
}

/** PUT helper, mirrors apiPost. */
export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await authedFetch(path, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toError(res);
  return res.json() as Promise<T>;
}

async function toError(res: Response): Promise<Error> {
  const text = await res.text().catch(() => "");
  try {
    const json = JSON.parse(text);
    return new Error(json.detail || json.message || `${res.status}`);
  } catch {
    return new Error(text || `HTTP ${res.status}`);
  }
}
