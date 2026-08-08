// Pure-logic tests for the CSP policy string and the violation projection
// (fleet-chezmoi#1646). The DB half is covered against the real fetch handler
// and real local D1 in tests-integration/worker.test.ts; these two suites cover
// different failure modes and neither substitutes for the other.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CSP_FIELD_CAPS,
  CSP_REPORT_MAX_BYTES,
  buildCspReportOnly,
  buildReportingEndpoints,
  extractCspReport,
  stripUrlNoise,
} from "../src/csp";

describe("report-only policy string", () => {
  const p = buildCspReportOnly();

  it("names the collector in both the legacy and the current directive", () => {
    // Dropping either loses reports from a whole class of browser, and a
    // collector that misses the browsers most likely to be running is not one.
    expect(p).toContain("report-uri /api/csp-report");
    expect(p).toContain("report-to csp-endpoint");
    expect(buildReportingEndpoints()).toBe('csp-endpoint="/api/csp-report"');
  });

  it("bounds where the page may send data, which is the directive that matters here", () => {
    expect(p).toContain("connect-src 'self'");
  });

  it("carries the directives that make a strict baseline strict", () => {
    for (const d of [
      "default-src 'self'",
      "script-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ]) {
      expect(p).toContain(d);
    }
  });

  // The deliberate omissions. Phase one ships STRICTER than the page is
  // believed to need so the exceptions are established by observation rather
  // than by reading app.js. If someone later adds these from a source read
  // rather than from collector data, this test is where that decision surfaces.
  it("does NOT pre-grant the exceptions the source suggests it will need", () => {
    expect(p).not.toContain("unsafe-inline");
    expect(p).not.toContain("data:");
    expect(p).not.toContain("blob:");
  });
});

// ROUTE ORDERING, asserted here because the integration suite structurally
// cannot see it. That pool binds no AUTH_MODE, so `authMode(env)` is never
// "public" and the public-mode gate never executes there; an "unauthenticated
// access works" test would pass identically whether the collector sat above or
// below the gate. This is a source assertion and it says so, but it is a source
// assertion about the one property that decides whether the collector collects
// anything at all: browsers post violation reports WITHOUT credentials, so a
// session-gated collector is an empty table forever.
describe("the collector is routed above the public-mode auth gate", () => {
  const indexSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/index.ts"),
    "utf8",
  );

  const gateMarker = 'authMode(env) === "public" &&';
  const routeMarker = 'url.pathname === "/api/csp-report"';

  // Controls first, so a matcher that has stopped matching fails as a broken
  // instrument rather than as a passing ordering claim.
  it("both markers are present (control)", () => {
    expect(indexSrc).toContain(gateMarker);
    expect(indexSrc).toContain(routeMarker);
  });

  it("the collector route appears before the gate", () => {
    const routeAt = indexSrc.indexOf(routeMarker);
    const gateAt = indexSrc.indexOf(gateMarker);
    expect(routeAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(-1);
    expect(
      routeAt,
      "the CSP collector must be routed ABOVE the public-mode gate; browsers " +
        "post violation reports with no credentials, so a gated collector " +
        "silently collects nothing",
    ).toBeLessThan(gateAt);
  });
});

describe("stripUrlNoise", () => {
  it("removes query and fragment", () => {
    expect(stripUrlNoise("https://play.skyphusion.org/x?a=1&b=2#frag")).toBe(
      "https://play.skyphusion.org/x",
    );
  });

  it("leaves a clean URL alone", () => {
    expect(stripUrlNoise("https://play.skyphusion.org/")).toBe("https://play.skyphusion.org/");
  });

  it("returns an unparseable value capped rather than dropping it", () => {
    // Knowing a violation happened somewhere unrecognisable beats a null.
    expect(stripUrlNoise("not a url")).toBe("not a url");
  });

  it("caps length", () => {
    const long = "https://x.example/" + "a".repeat(5000);
    expect(stripUrlNoise(long)!.length).toBeLessThanOrEqual(CSP_FIELD_CAPS.document_uri);
  });

  it("returns null for non-strings and blanks", () => {
    expect(stripUrlNoise(null)).toBeNull();
    expect(stripUrlNoise(42)).toBeNull();
    expect(stripUrlNoise("   ")).toBeNull();
  });
});

describe("extractCspReport", () => {
  it("reads the legacy report-uri shape", () => {
    const r = extractCspReport({
      "csp-report": {
        "document-uri": "https://play.skyphusion.org/?x=1",
        "violated-directive": "style-src 'self'",
        "effective-directive": "style-src-attr",
        "blocked-uri": "inline",
        disposition: "report",
        "status-code": 200,
        "line-number": 47,
      },
    });
    expect(r).not.toBeNull();
    expect(r!.document_uri).toBe("https://play.skyphusion.org/");
    expect(r!.effective_directive).toBe("style-src-attr");
    expect(r!.blocked_uri).toBe("inline");
    expect(r!.status_code).toBe(200);
    expect(r!.line_number).toBe(47);
  });

  it("reads the Reporting API shape", () => {
    const r = extractCspReport([
      {
        type: "csp-violation",
        body: {
          documentURL: "https://play.skyphusion.org/",
          effectiveDirective: "img-src",
          blockedURL: "data:image/png;base64,AAAA",
          disposition: "report",
        },
      },
    ]);
    expect(r).not.toBeNull();
    expect(r!.effective_directive).toBe("img-src");
    expect(r!.blocked_uri).toBe("data:image/png;base64,AAAA");
  });

  // Returning null rather than an all-null row is load-bearing: an empty row
  // records "a violation happened with no detail", which is indistinguishable
  // from a collector mangling its input.
  it("returns null when neither wire shape is present", () => {
    expect(extractCspReport({})).toBeNull();
    expect(extractCspReport([])).toBeNull();
    expect(extractCspReport({ nonsense: 1 })).toBeNull();
    expect(extractCspReport([{ type: "deprecation", body: {} }])).toBeNull();
    expect(extractCspReport("a string")).toBeNull();
    expect(extractCspReport(null)).toBeNull();
  });

  it("never persists script-sample under any key", () => {
    // Privacy call: script-sample can carry inline-script fragments from a page
    // that handles a credential. A violation is diagnosable without it.
    const r = extractCspReport({
      "csp-report": {
        "document-uri": "https://play.skyphusion.org/",
        "script-sample": "const token = 'SUPER SECRET VALUE'",
        "effective-directive": "script-src",
      },
    });
    expect(r).not.toBeNull();
    expect(JSON.stringify(r)).not.toContain("SUPER SECRET");
    expect(Object.keys(r!)).not.toContain("script_sample");
  });

  it("caps every string field against a hostile oversized report", () => {
    const huge = "z".repeat(9000);
    const r = extractCspReport({
      "csp-report": {
        "document-uri": huge,
        referrer: huge,
        "violated-directive": huge,
        "effective-directive": huge,
        "blocked-uri": huge,
        disposition: huge,
        "source-file": huge,
      },
    })!;
    expect(r.referrer!.length).toBeLessThanOrEqual(CSP_FIELD_CAPS.referrer);
    expect(r.violated_directive!.length).toBeLessThanOrEqual(CSP_FIELD_CAPS.violated_directive);
    expect(r.effective_directive!.length).toBeLessThanOrEqual(CSP_FIELD_CAPS.effective_directive);
    expect(r.blocked_uri!.length).toBeLessThanOrEqual(CSP_FIELD_CAPS.blocked_uri);
    expect(r.disposition!.length).toBeLessThanOrEqual(CSP_FIELD_CAPS.disposition);
    expect(r.source_file!.length).toBeLessThanOrEqual(CSP_FIELD_CAPS.source_file);
    expect(r.document_uri!.length).toBeLessThanOrEqual(CSP_FIELD_CAPS.document_uri);
  });

  it("refuses non-numeric and out-of-range numerics rather than coercing", () => {
    const r = extractCspReport({
      "csp-report": {
        "document-uri": "https://x.example/",
        "status-code": "200",
        "line-number": -5,
        "column-number": 1e12,
      },
    })!;
    expect(r.status_code).toBeNull();
    expect(r.line_number).toBeNull();
    expect(r.column_number).toBeNull();
  });

  it("exports a body cap that is bounded and non-trivial", () => {
    expect(CSP_REPORT_MAX_BYTES).toBeGreaterThan(1024);
    expect(CSP_REPORT_MAX_BYTES).toBeLessThanOrEqual(65536);
  });
});
