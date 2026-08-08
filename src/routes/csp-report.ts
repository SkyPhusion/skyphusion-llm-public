// POST /api/csp-report -- the CSP violation collector (fleet-chezmoi#1646).
//
// THIS ROUTE IS UNAUTHENTICATED AND CANNOT BE OTHERWISE. Browsers post CSP
// reports without credentials, so a token gate would collect nothing. Every
// design choice below follows from that: anyone can post here, at any volume,
// with any body, so the body is capped, the projection is a fixed field set,
// every field is length-bounded, the rate is limited, and shedding is counted
// rather than silent.
//
// The pure half (policy string, field caps, report projection) is in src/csp.ts
// and is unit-tested without D1. This file does the window and the insert.

import type { Env } from "../env";
import { rateLimitDecision } from "../rate-limit";
import {
  CSP_FIELD_CAPS,
  CSP_RATE_LIMIT,
  CSP_RATE_WINDOW_SECONDS,
  CSP_REPORT_MAX_BYTES,
  CSP_RETENTION_DAYS,
  extractCspReport,
} from "../csp";

/**
 * Reports are fire-and-forget from the browser's side; nothing reads the body.
 * Every return is 204 with no body EXCEPT the refusals we want to be able to
 * test and count, which carry a status that says which refusal fired.
 */
const NO_CONTENT = () => new Response(null, { status: 204 });

/**
 * Rate-limit window against the collector's OWN bucket table.
 *
 * Deliberately not `checkRateLimit` from src/rate-limit.ts: that writes to
 * `auth_attempts`, and pointing an unauthenticated public write path at the
 * table the login limiter depends on couples a flood here to sign-in there.
 * The pure decision function IS reused, so the window semantics cannot drift
 * from the audited ones.
 */
async function windowFor(
  db: D1Database,
  bucketKey: string,
): Promise<{ allowed: boolean }> {
  const row = await db
    .prepare(
      `SELECT count, CAST(strftime('%s', window_start) AS INTEGER) AS ws
         FROM csp_report_buckets WHERE bucket_key = ?`,
    )
    .bind(bucketKey)
    .first<{ count: number; ws: number }>();
  const nowRow = await db
    .prepare(`SELECT CAST(strftime('%s','now') AS INTEGER) AS now`)
    .first<{ now: number }>();
  const now = nowRow?.now ?? 0;

  const d = rateLimitDecision(
    now,
    row?.ws ?? null,
    row?.count ?? 0,
    CSP_RATE_LIMIT,
    CSP_RATE_WINDOW_SECONDS,
  );

  // `dropped` is what makes shedding visible. Without it a rate-limited estate
  // and a quiet one produce an identical empty csp_reports table, and the
  // difference between "nothing is violating" and "we threw it away" is the
  // whole question this collector exists to answer.
  await db
    .prepare(
      `INSERT INTO csp_report_buckets (bucket_key, count, dropped, window_start)
       VALUES (?, ?, ?, datetime(?, 'unixepoch'))
       ON CONFLICT(bucket_key) DO UPDATE SET
         count = excluded.count,
         dropped = csp_report_buckets.dropped + excluded.dropped,
         window_start = excluded.window_start`,
    )
    .bind(bucketKey, d.nextCount, d.allowed ? 0 : 1, d.nextWindowStart)
    .run();

  return { allowed: d.allowed };
}

export async function handleCspReport(request: Request, env: Env): Promise<Response> {
  // 1. Size. Refuse PAST the cap rather than accepting a truncated record.
  //    A collector that stores a mangled row past its limit is worse than one
  //    that refuses, because the mangled row looks like a real observation.
  //    Content-Length is a claim, so it is checked as a cheap early refusal AND
  //    the actual bytes are measured after reading; a lying or absent header
  //    cannot get a oversized body past the second check.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > CSP_REPORT_MAX_BYTES) {
    return new Response(null, { status: 413 });
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return new Response(null, { status: 400 });
  }
  if (raw.length > CSP_REPORT_MAX_BYTES) {
    return new Response(null, { status: 413 });
  }

  // 2. Parse. Malformed is refused, not stored as an empty row.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400 });
  }

  // 3. Project to the bounded row. null means neither wire shape was present,
  //    which is a malformed report rather than a violation with no detail.
  const row = extractCspReport(parsed);
  if (!row) return new Response(null, { status: 400 });

  // 4. Rate limit. Keyed on the connecting IP; CF-Connecting-IP is set by the
  //    edge and is not client-settable on this path. A missing header buckets
  //    to "unknown", which shares one window rather than bypassing the limit.
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const { allowed } = await windowFor(env.DB, `csp:${ip}`.slice(0, 128));
  if (!allowed) {
    // 429 rather than a silent 204: a shed report must be distinguishable from
    // an accepted one by the sender too, not only in our own counter.
    return new Response(null, { status: 429 });
  }

  await env.DB.prepare(
    `INSERT INTO csp_reports
       (document_uri, referrer, violated_directive, effective_directive,
        blocked_uri, disposition, status_code, source_file, line_number, column_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.document_uri,
      row.referrer,
      row.violated_directive,
      row.effective_directive,
      row.blocked_uri,
      row.disposition,
      row.status_code,
      row.source_file,
      row.line_number,
      row.column_number,
    )
    .run();

  // 5. Retention as an executed deletion, not an intention. Prune-on-write
  //    needs no cron, no new trigger and no binding, and it cannot drift out of
  //    sync with the write path because it IS the write path.
  await env.DB.prepare(
    `DELETE FROM csp_reports WHERE received_at < datetime('now', ?)`,
  )
    .bind(`-${CSP_RETENTION_DAYS} days`)
    .run();

  return NO_CONTENT();
}

// Re-exported so the route table and the tests agree on the cap without a
// second copy of the number.
export { CSP_REPORT_MAX_BYTES, CSP_FIELD_CAPS };
