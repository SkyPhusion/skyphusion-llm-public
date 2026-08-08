// CSP collector against the real fetch handler and real local D1
// (fleet-chezmoi#1646).
//
// WHAT THIS SUITE CAN AND CANNOT SEE, stated up front because one of the
// properties that matters most is NOT provable here:
//
//   - It CAN prove the handler's behaviour end to end: refusal past the body
//     cap, refusal of malformed input, the bounded projection actually landing
//     in D1, the rate limit, and that shedding is counted rather than silent.
//   - It CANNOT prove the route is reachable without a session. This pool binds
//     no AUTH_MODE, so `authMode(env)` is not "public" and the public-mode gate
//     never executes. An "unauthenticated access works" assertion here would
//     pass identically whether the route sat above or below that gate, which
//     makes it no assertion at all. The route-ordering property is asserted
//     against the source in tests/csp.test.ts instead, with a control.
//   - It CANNOT prove the report-only header lands on the HTML document,
//     because ASSETS is mocked as a 404 Fetcher with no HTML. It CAN prove the
//     non-HTML branch, and the HTML branch is covered by the live browser
//     acceptance recorded on the PR.

import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import schemaSql from "../schema.sql?raw";

const ORIGIN = "https://play.example.org";
const REPORT_URL = `${ORIGIN}/api/csp-report`;

async function applySchema(db: D1Database): Promise<void> {
  const statements = schemaSql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    try {
      await db.prepare(stmt).run();
    } catch (e) {
      const msg = String((e as { message?: string })?.message ?? e);
      if (/duplicate column name|already exists/i.test(msg)) continue;
      throw e;
    }
  }
}

function legacyReport(overrides: Record<string, unknown> = {}) {
  return {
    "csp-report": {
      "document-uri": `${ORIGIN}/`,
      "violated-directive": "style-src 'self'",
      "effective-directive": "style-src-attr",
      "blocked-uri": "inline",
      disposition: "report",
      "status-code": 200,
      ...overrides,
    },
  };
}

function post(body: string, headers: Record<string, string> = {}) {
  return SELF.fetch(REPORT_URL, {
    method: "POST",
    headers: { "content-type": "application/csp-report", ...headers },
    body,
  });
}

async function rowCount(): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM csp_reports`).first<{ n: number }>();
  return r?.n ?? 0;
}

describe("POST /api/csp-report", () => {
  beforeEach(async () => {
    await applySchema(env.DB);
    await env.DB.prepare(`DELETE FROM csp_reports`).run();
    await env.DB.prepare(`DELETE FROM csp_report_buckets`).run();
  });

  it("accepts a real report and persists the bounded projection", async () => {
    const res = await post(JSON.stringify(legacyReport()));
    expect(res.status).toBe(204);

    const row = await env.DB.prepare(
      `SELECT document_uri, effective_directive, blocked_uri, disposition, status_code
         FROM csp_reports ORDER BY id DESC LIMIT 1`,
    ).first<Record<string, unknown>>();

    expect(row).toBeTruthy();
    expect(row!.document_uri).toBe(`${ORIGIN}/`);
    expect(row!.effective_directive).toBe("style-src-attr");
    expect(row!.blocked_uri).toBe("inline");
    expect(row!.status_code).toBe(200);
  });

  it("strips query and fragment from the stored document_uri", async () => {
    await post(JSON.stringify(legacyReport({ "document-uri": `${ORIGIN}/x?tok=SECRETVALUE#f` })));
    const row = await env.DB.prepare(
      `SELECT document_uri FROM csp_reports ORDER BY id DESC LIMIT 1`,
    ).first<{ document_uri: string }>();
    expect(row!.document_uri).toBe(`${ORIGIN}/x`);
    expect(row!.document_uri).not.toContain("SECRETVALUE");
  });

  it("never persists script-sample end to end", async () => {
    await post(
      JSON.stringify(legacyReport({ "script-sample": "const t = 'SUPER SECRET VALUE'" })),
    );
    const row = await env.DB.prepare(
      `SELECT * FROM csp_reports ORDER BY id DESC LIMIT 1`,
    ).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain("SUPER SECRET");
  });

  // THE CAP MUST REFUSE, NOT TRUNCATE. A collector that stores a mangled row
  // past its limit is worse than one that refuses, because the mangled row
  // looks like a real observation. So the assertion is not merely "413": it is
  // "413 AND nothing was written".
  it("refuses past the body cap and writes nothing", async () => {
    const before = await rowCount();
    const huge = JSON.stringify(legacyReport({ referrer: "z".repeat(20000) }));
    const res = await post(huge);
    expect(res.status).toBe(413);
    expect(await rowCount()).toBe(before);
  });

  it("refuses an oversized body even when content-length lies", async () => {
    // content-length is a claim. The post-read byte check is what actually
    // bounds it, so a header understating the size must not get past.
    const before = await rowCount();
    const huge = JSON.stringify(legacyReport({ referrer: "z".repeat(20000) }));
    const res = await post(huge, { "content-length": "10" });
    expect(res.status).toBe(413);
    expect(await rowCount()).toBe(before);
  });

  it("refuses malformed JSON without writing a row", async () => {
    const before = await rowCount();
    const res = await post("{not json");
    expect(res.status).toBe(400);
    expect(await rowCount()).toBe(before);
  });

  it("refuses a well-formed body that is not a CSP report, without writing an empty row", async () => {
    // An all-null row would record "a violation happened with no detail",
    // which is indistinguishable from the collector mangling its input.
    const before = await rowCount();
    const res = await post(JSON.stringify({ hello: "world" }));
    expect(res.status).toBe(400);
    expect(await rowCount()).toBe(before);
  });

  it("does not answer GET", async () => {
    const res = await SELF.fetch(REPORT_URL, { method: "GET" });
    expect(res.status).not.toBe(204);
  });

  // SHEDDING MUST BE VISIBLE. Without the counter, a rate-limited estate and a
  // quiet one produce an identical empty table.
  it("rate limits, and counts what it drops", async () => {
    const body = JSON.stringify(legacyReport());
    let sawLimit = false;
    for (let i = 0; i < 70; i++) {
      const res = await post(body, { "cf-connecting-ip": "203.0.113.9" });
      if (res.status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(true);

    const bucket = await env.DB.prepare(
      `SELECT count, dropped FROM csp_report_buckets WHERE bucket_key = ?`,
    )
      .bind("csp:203.0.113.9")
      .first<{ count: number; dropped: number }>();

    expect(bucket).toBeTruthy();
    expect(bucket!.dropped).toBeGreaterThan(0);
  });

  it("buckets per client rather than globally", async () => {
    const body = JSON.stringify(legacyReport());
    await post(body, { "cf-connecting-ip": "203.0.113.1" });
    await post(body, { "cf-connecting-ip": "203.0.113.2" });
    const rows = await env.DB.prepare(
      `SELECT bucket_key FROM csp_report_buckets ORDER BY bucket_key`,
    ).all<{ bucket_key: string }>();
    const keys = (rows.results || []).map((r) => r.bucket_key);
    expect(keys).toContain("csp:203.0.113.1");
    expect(keys).toContain("csp:203.0.113.2");
  });
});

describe("security headers on the static surface", () => {
  it("sets HSTS without preload on the assets fallthrough", async () => {
    const res = await SELF.fetch(`${ORIGIN}/some-static-path`);
    const hsts = res.headers.get("strict-transport-security");
    expect(hsts).toBeTruthy();
    expect(hsts).toContain("max-age=");
    // preload is the genuinely irreversible one and is deliberately absent.
    expect(hsts).not.toContain("preload");
  });

  // ASSETS is mocked as a non-HTML 404 here, so this asserts the NON-HTML
  // branch: a policy on a subresource governs nothing and is not emitted. The
  // HTML branch is covered by the live browser acceptance on the PR, because
  // this pool has no HTML to serve.
  it("does not put a document policy on a non-HTML response", async () => {
    const res = await SELF.fetch(`${ORIGIN}/some-static-path`);
    expect(res.headers.get("content-security-policy-report-only")).toBeNull();
  });
});
