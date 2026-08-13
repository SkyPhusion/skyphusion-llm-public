// Content-Security-Policy: the policy string, and the pure projection of a
// violation report into the bounded row we persist (fleet-chezmoi#1646).
//
// Everything here is a pure function so it is testable in the fast node suite
// without booting workerd or D1. The DB layer lives in routes/csp-report.ts and
// does nothing but the rate-limit window and the insert.
//
// THE POLICY IS NOW ENFORCING. Phase one shipped it report-only and
// deliberately stricter than the page was believed to need, so that every
// exception would be established by an OBSERVED violation rather than by a
// directive list derived from reading app.js. That phase is over and its
// output is the two grants in buildCspPolicy below.
//
// WORTH KEEPING: phase one's author predicted, in this comment, exactly two
// violations -- an inline style attribute on the skip link, and a data: image
// preview. The measurement found FOUR distinct ones. The skip link and the
// data: image were both real. A blob: URL on TTS playback was not predicted,
// and an inline <style> block on the STT page was not only unpredicted but
// could not have reported at all, because that document was being served
// outside `run_worker_first` and carried no policy header.
//
// So a careful reading of the source got 2 of 4, and the two it missed are the
// ones that would have hurt: one silences voice chat, and the other was
// invisible to the very instrument that was supposed to find it. That is the
// argument for the report-only phase, made by the phase itself, and it is the
// reason a future directive change owes an observation rather than a reading.

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

/** The response header name. ENFORCING, not `-Report-Only`.
 *
 * Exported so the name and the mode cannot drift apart in a caller: a policy
 * built as enforcing and emitted under the report-only name is a strictly
 * decorative control, and nothing about either string announces the mismatch.
 */
export const CSP_HEADER = "content-security-policy";

/** The header name phase one used. Kept ONLY so tests can assert it is gone.
 *
 * A retired name is a live hazard rather than trivia: a check that looks for
 * the old header keeps passing after promotion by finding nothing, which is
 * indistinguishable from the header being correctly absent. Asserting on this
 * constant makes "the report-only header is no longer emitted" a claim a test
 * can actually make.
 */
export const CSP_HEADER_REPORT_ONLY = "content-security-policy-report-only";

/**
 * The ENFORCING policy served on HTML responses.
 *
 * PROMOTED FROM REPORT-ONLY on mackaye's ruling, fleet-chezmoi#1646 comment
 * 5281677490, after the report-only phase measured what the page genuinely
 * needs. Every exception below was established by a violation that was
 * OBSERVED, never by reading app.js and deciding what looked necessary. That
 * ordering is the whole point of having had a report-only phase, and it is
 * cheap to quietly invert later, so the provenance of each grant is recorded
 * here rather than in a merged PR nobody re-reads.
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
 * REGISTERED by the browser while the collector received zero rows, so the
 * violation was real and the DELIVERY was the failure. Removing `report-to`
 * and the `Reporting-Endpoints` header, changing nothing else, made the
 * identical violations arrive immediately. Re-adding `report-to` is a change
 * that must be justified by watching a report arrive over it, not by noting
 * that it is the modern directive.
 *
 * THE COLLECTOR STAYS WIRED UNDER ENFORCEMENT, and that is not leftovers. The
 * stored `disposition` column now distinguishes `enforce` from `report`, so a
 * directive this policy gets wrong shows up as a row naming the thing that was
 * actually broken, instead of as a user reporting that a feature stopped
 * working. Dropping `report-uri` at promotion would retire the instrument at
 * the exact moment it starts describing real refusals.
 *
 * THE TWO GRANTS, each with the observation that produced it. Both were
 * measured violating in a browser run whose off-origin positive control fired
 * in the same run, so neither rests on a zero from an instrument that might
 * simply have been blind.
 *
 *   `img-src 'self' data:`
 *     Attachment thumbnails, extracted video-frame previews, and the downscale
 *     path that feeds them all render a `data:` URL the page produced itself
 *     from a local file. Observed as `img-src | data`.
 *
 *   `media-src 'self' blob:`
 *     TTS playback constructs an `Audio` around a `blob:` URL minted from a
 *     same-origin response. Observed as `media-src | blob`.
 *
 * WHY GRANT RATHER THAN REWORK, since the rework reads as the more rigorous
 * option and is the worse one: making the previews same-origin means uploading
 * a user's local image to a server in order to show it back to them in their
 * own browser. Prism is BYOK and privacy-primary. The policy exists to serve
 * that posture, not to outrank it. And promoting with the two features broken
 * is worse still, because a control that fires during healthy operation
 * teaches everyone that its red means nothing, so the next red arrives
 * pre-discounted and the policy eventually gets switched off.
 *
 * WHAT THE GRANTS DO NOT BUY, stated so a later reader does not have to
 * re-derive the blast radius: neither admits script execution. `blob:` is
 * same-origin-created by construction. `data:` here is scoped to `img-src`
 * alone, whose realistic downside is UI spoofing rather than code execution.
 *
 * NOTHING ELSE WIDENED. `script-src` and `connect-src` are unchanged from the
 * measured baseline, `object-src` stays `'none'`, and no `unsafe-inline` or
 * `unsafe-eval` appears anywhere. Adding a directive to make a violation stop
 * arriving is the inversion this whole exercise exists to prevent; tests assert
 * each of those absences by name so a future grant has to be deliberate.
 */
export function buildCspPolicy(reportPath = "/api/csp-report"): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    // GRANTED: local file previews, never uploaded. Observed `img-src | data`.
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    // GRANTED: TTS playback of a same-origin response. Observed `media-src | blob`.
    "media-src 'self' blob:",
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
