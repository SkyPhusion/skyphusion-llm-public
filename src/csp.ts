// Content-Security-Policy: the policy string, and the pure projection of a
// violation report into the bounded row we persist (fleet-chezmoi#1646).
//
// Everything here is a pure function so it is testable in the fast node suite
// without booting workerd or D1. The DB layer lives in routes/csp-report.ts and
// does nothing but the rate-limit window and the insert.
//
// PHASE ONE IS REPORT-ONLY AND THE POLICY IS DELIBERATELY STRICTER THAN WHAT I
// BELIEVE THE PAGE NEEDS. That is not an oversight. Promotion to enforcing is
// gated on what the collector actually observes, not on a directive list
// derived by reading the source, so this ships the strict baseline and lets the
// reports establish each exception. I can see at least two that will fire (an
// inline style attribute on the skip link, and a data: image preview), and
// pre-adding them from my own reading is exactly the hand-derivation the gate
// exists to prevent. A report proving an exception is needed is evidence; my
// reading of app.js is a claim.

/** Max accepted request body, in bytes. A CSP report is small; this is generous. */
export const CSP_REPORT_MAX_BYTES = 8192;

/** Per-field character caps. Every value here is attacker-controlled. */
export const CSP_FIELD_CAPS = {
  document_uri: 512,
  referrer: 512,
  violated_directive: 128,
  effective_directive: 128,
  blocked_uri: 512,
  disposition: 32,
  source_file: 512,
} as const;

/** Reports accepted per window, per client. */
export const CSP_RATE_LIMIT = 60;
/** Rate-limit window, seconds. */
export const CSP_RATE_WINDOW_SECONDS = 300;
/** Rows older than this are pruned on write. Deletion path, not an intention. */
export const CSP_RETENTION_DAYS = 30;

export interface CspReportRow {
  document_uri: string | null;
  referrer: string | null;
  violated_directive: string | null;
  effective_directive: string | null;
  blocked_uri: string | null;
  disposition: string | null;
  status_code: number | null;
  source_file: string | null;
  line_number: number | null;
  column_number: number | null;
}

/**
 * The report-only policy served on HTML responses.
 *
 * `report-uri` is deprecated and is the one every current browser still
 * actually posts; `report-to` is the replacement and needs the companion
 * `Reporting-Endpoints` header. Both are emitted, because dropping the legacy
 * directive would silently lose reports from browsers that never implemented
 * the newer one, and a collector that misses the browsers most likely to be
 * running is not a collector.
 */
export function buildCspReportOnly(reportPath = "/api/csp-report"): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    `report-uri ${reportPath}`,
    "report-to csp-endpoint",
  ].join("; ");
}

/** Companion header naming the group `report-to` above refers to. */
export function buildReportingEndpoints(reportPath = "/api/csp-report"): string {
  return `csp-endpoint="${reportPath}"`;
}

function capped(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

function intOrNull(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  // Bound it: these are line/column/status numbers, not arbitrary integers.
  const n = Math.trunc(v);
  if (n < 0 || n > 100_000_000) return null;
  return n;
}

/**
 * Strip query and fragment from a document URI before storage.
 *
 * The SPA puts nothing in URLs, which was measured rather than assumed, so this
 * changes nothing today. It exists so the collector cannot become the first
 * place a URL-borne value gets persisted if that ever stops being true. An
 * unparseable value is returned capped rather than dropped, because knowing a
 * violation happened somewhere unrecognisable is still worth more than a null.
 */
export function stripUrlNoise(raw: unknown): string | null {
  const s = capped(raw, CSP_FIELD_CAPS.document_uri);
  if (s === null) return null;
  try {
    const u = new URL(s);
    u.search = "";
    u.hash = "";
    return u.toString().slice(0, CSP_FIELD_CAPS.document_uri);
  } catch {
    return s;
  }
}

/**
 * Project a parsed report body into the bounded row.
 *
 * Accepts BOTH wire shapes and returns null when neither is present:
 *   - `report-uri`: {"csp-report": {...}} with hyphenated keys
 *   - `report-to`:  [{"type":"csp-violation","body":{...}}] with underscored keys
 *
 * Returning null rather than an empty row matters: an empty row is a record
 * that a violation occurred with no detail, which is indistinguishable from a
 * collector that is mangling its input.
 */
export function extractCspReport(parsed: unknown): CspReportRow | null {
  let b: Record<string, unknown> | null = null;

  if (Array.isArray(parsed)) {
    const entry = parsed.find(
      (e) => e && typeof e === "object" && (e as Record<string, unknown>).type === "csp-violation",
    ) as Record<string, unknown> | undefined;
    const body = entry?.body;
    if (body && typeof body === "object") b = body as Record<string, unknown>;
  } else if (parsed && typeof parsed === "object") {
    const legacy = (parsed as Record<string, unknown>)["csp-report"];
    if (legacy && typeof legacy === "object") b = legacy as Record<string, unknown>;
  }

  if (!b) return null;

  // Hyphenated (report-uri) first, underscored (Reporting API) second.
  const pick = (a: string, z: string): unknown => (b![a] !== undefined ? b![a] : b![z]);

  return {
    document_uri: stripUrlNoise(pick("document-uri", "documentURL")),
    referrer: capped(pick("referrer", "referrer"), CSP_FIELD_CAPS.referrer),
    violated_directive: capped(
      pick("violated-directive", "violatedDirective"),
      CSP_FIELD_CAPS.violated_directive,
    ),
    effective_directive: capped(
      pick("effective-directive", "effectiveDirective"),
      CSP_FIELD_CAPS.effective_directive,
    ),
    blocked_uri: capped(pick("blocked-uri", "blockedURL"), CSP_FIELD_CAPS.blocked_uri),
    disposition: capped(pick("disposition", "disposition"), CSP_FIELD_CAPS.disposition),
    status_code: intOrNull(pick("status-code", "statusCode")),
    source_file: capped(pick("source-file", "sourceFile"), CSP_FIELD_CAPS.source_file),
    line_number: intOrNull(pick("line-number", "lineNumber")),
    column_number: intOrNull(pick("column-number", "columnNumber")),
  };
}
