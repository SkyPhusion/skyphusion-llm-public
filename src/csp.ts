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
 * ONLY `report-uri`, DELIBERATELY, AND THIS WAS MEASURED RATHER THAN REASONED.
 *
 * The obvious shape is to emit both: `report-uri` for browsers that never
 * implemented the replacement, plus `report-to` with a companion
 * `Reporting-Endpoints` header for those that did. That is what this shipped
 * first, and it delivered NOTHING.
 *
 * Measured, with the two states separated rather than inferred. A
 * `securitypolicyviolation` listener in the page proved violations were being
 * REGISTERED by the browser (two of them, `disposition: "report"`), while the
 * collector received zero rows. So the violation was real and the DELIVERY was
 * the failure. Removing `report-to` and the `Reporting-Endpoints` header,
 * changing nothing else, made the identical violations arrive immediately --
 * including a load-time one from the skip link's inline style attribute that no
 * test had provoked.
 *
 * Conclusion held to what the evidence supports: emitting `report-to` alongside
 * `report-uri` SUPPRESSED delivery in the observed environment. The likely
 * reason is that the Reporting API declines to deliver from a non-secure origin
 * and takes precedence once declared, but that is INFERRED -- an HTTPS run has
 * not been done, and the mechanism is not what this decision rests on.
 *
 * What it rests on is narrower and sufficient: `report-uri` is the only
 * transport this collector has ever been OBSERVED to receive a report over.
 * Shipping a phase whose entire purpose is observation, over a transport whose
 * delivery has only ever been seen to fail, is the defect this work exists to
 * prevent. Re-adding `report-to` is a change that must be justified by watching
 * a report arrive over it, not by noting that it is the modern directive.
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
  ].join("; ");
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
