// HTTP client for prism-control-plane (play-proxy).
//
// When a user configures a pcp_ client key, chat bills through the metered proxy
// instead of the user's own AI Gateway (BYOK). The base URL is NOT user-chosen
// (SSRF): only an allowlisted host from worker config / default, never prefs.
//
// Contract: skyphusion-labs/prism-control-plane docs/CONTRACT.md

import type { Env } from "./env";
import type { UserPrefsJson } from "./user-prefs";

export const DEFAULT_CONTROL_PLANE_URL = "https://play-proxy.skyphusion.org";

/** Exact hostnames the worker may call for control-plane inference. */
export const CONTROL_PLANE_ALLOWED_HOSTS: readonly string[] = [
  "play-proxy.skyphusion.org",
];

export interface ControlPlaneCredentials {
  baseUrl: string;
  clientKey: string;
}

/** Shape-check a pcp_ client key without hitting the network. */
export function looksLikeClientKey(raw: string): boolean {
  // pcp_ + 16 hex + _ + 43 base64url (matches control-plane parseClientKey)
  return /^pcp_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/.test(raw.trim());
}

/** Strip trailing slashes without a regex (CodeQL js/polynomial-redos on /\/+$/). */
export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* / */) end -= 1;
  return s.slice(0, end);
}

/**
 * Parse and allowlist a control-plane origin.
 * Returns canonical `https://host` or null (refuse everything else).
 *
 * SSRF guard: only CONTROL_PLANE_ALLOWED_HOSTS (plus optional localhost when
 * CONTROL_PLANE_ALLOW_LOCALHOST=true for local wrangler dev).
 */
export function allowlistedControlPlaneOrigin(
  raw: string,
  opts?: { allowLocalhost?: boolean },
): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 256) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(opts?.allowLocalhost && url.protocol === "http:")) {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  // Only origin path: empty or single slash.
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.port && url.port !== "443" && !(opts?.allowLocalhost && url.port === "8787")) {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const allowed = new Set(CONTROL_PLANE_ALLOWED_HOSTS);
  if (opts?.allowLocalhost) {
    allowed.add("localhost");
    allowed.add("127.0.0.1");
  }
  if (!allowed.has(host)) return null;

  if (opts?.allowLocalhost && (host === "localhost" || host === "127.0.0.1")) {
    const port = url.port ? `:${url.port}` : "";
    return `${url.protocol}//${host}${port}`;
  }
  return `https://${host}`;
}

/**
 * Resolve control-plane credentials.
 * URL comes from env (or default allowlisted host), NEVER from user prefs.
 */
export function resolveControlPlane(
  prefs: UserPrefsJson | null,
  env?: Pick<Env, "CONTROL_PLANE_URL" | "CONTROL_PLANE_ALLOW_LOCALHOST">,
): ControlPlaneCredentials | null {
  const key = prefs?.control_plane_key?.trim() || "";
  if (!key || !looksLikeClientKey(key)) return null;

  const allowLocalhost = (env?.CONTROL_PLANE_ALLOW_LOCALHOST ?? "").trim() === "true";
  const configured = (env?.CONTROL_PLANE_URL ?? "").trim() || DEFAULT_CONTROL_PLANE_URL;
  const base = allowlistedControlPlaneOrigin(configured, { allowLocalhost });
  if (!base) return null;
  return { baseUrl: base, clientKey: key };
}

export interface ControlPlaneChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ControlPlaneChatResult {
  text: string;
  model: string;
  usage: { prompt_tokens: number | null; completion_tokens: number | null };
  requestId: string | null;
  raw: unknown;
}

function authHeaders(cp: ControlPlaneCredentials): HeadersInit {
  return {
    authorization: `Bearer ${cp.clientKey}`,
    "content-type": "application/json",
    accept: "application/json",
  };
}

/** Build a fixed path under the allowlisted origin (no user path injection). */
export function controlPlaneUrl(cp: ControlPlaneCredentials, path: "/v1/chat/completions" | "/v1/models" | "/v1/me"): string {
  return `${cp.baseUrl}${path}`;
}

/**
 * Non-streaming chat completion against the control plane.
 * Throws Error with optional .status / .code for API failures.
 */
export async function controlPlaneChat(
  cp: ControlPlaneCredentials,
  args: {
    model: string;
    messages: ControlPlaneChatMessage[];
    max_tokens?: number;
    temperature?: number;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ControlPlaneChatResult> {
  // Defense in depth: re-allowlist before fetch (credentials must already be clean).
  if (!allowlistedControlPlaneOrigin(cp.baseUrl, { allowLocalhost: true })) {
    throw new Error("control-plane base URL is not allowlisted");
  }

  const res = await fetchImpl(controlPlaneUrl(cp, "/v1/chat/completions"), {
    method: "POST",
    headers: authHeaders(cp),
    body: JSON.stringify({
      model: args.model,
      messages: args.messages,
      ...(args.max_tokens !== undefined ? { max_tokens: args.max_tokens } : {}),
      ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
      stream: false,
    }),
  });

  const requestId = res.headers.get("prism-request-id");
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    const err = new Error(`control-plane: unparseable body (HTTP ${res.status})`) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }

  if (!res.ok) {
    const errObj = body as { error?: { message?: string; code?: string } };
    const msg =
      errObj?.error?.message ||
      (typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : `control-plane HTTP ${res.status}`);
    const err = new Error(msg) as Error & { status?: number; code?: string };
    err.status = res.status;
    err.code = errObj?.error?.code;
    throw err;
  }

  const text = extractChatText(body);
  const usageRaw = (body as { usage?: Record<string, unknown> })?.usage;
  return {
    text,
    model: String((body as { model?: string })?.model || args.model),
    usage: {
      prompt_tokens: intOrNull(usageRaw?.prompt_tokens ?? usageRaw?.input_tokens),
      completion_tokens: intOrNull(usageRaw?.completion_tokens ?? usageRaw?.output_tokens),
    },
    requestId,
    raw: body,
  };
}

/** List models the caller may use (plan-filtered, with prices). */
export async function controlPlaneListModels(
  cp: ControlPlaneCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  if (!allowlistedControlPlaneOrigin(cp.baseUrl, { allowLocalhost: true })) {
    throw new Error("control-plane base URL is not allowlisted");
  }
  const res = await fetchImpl(controlPlaneUrl(cp, "/v1/models"), {
    method: "GET",
    headers: {
      authorization: `Bearer ${cp.clientKey}`,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`control-plane /v1/models HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res.json();
}

/** Account/plan/usage snapshot. */
export async function controlPlaneMe(
  cp: ControlPlaneCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  if (!allowlistedControlPlaneOrigin(cp.baseUrl, { allowLocalhost: true })) {
    throw new Error("control-plane base URL is not allowlisted");
  }
  const res = await fetchImpl(controlPlaneUrl(cp, "/v1/me"), {
    method: "GET",
    headers: {
      authorization: `Bearer ${cp.clientKey}`,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`control-plane /v1/me HTTP ${res.status}`);
  }
  return res.json();
}

function extractChatText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const o = body as Record<string, unknown>;
  const choices = o.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const msg = (choices[0] as { message?: { content?: unknown } }).message;
    if (msg && typeof msg.content === "string") return msg.content;
  }
  if (typeof o.response === "string") return o.response;
  if (typeof o.result === "string") return o.result;
  return "";
}

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}
