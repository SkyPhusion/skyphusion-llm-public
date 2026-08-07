// Tests for the SPA link-scheme allowlist (public/url-safety.js) and its
// wiring into the transcript renderer and the credential modal.
//
// TWO KINDS OF ASSERTION LIVE HERE AND THEY ARE NOT EQUALLY STRONG. Said
// plainly so nobody reads the file as more than it is:
//
//   1. BEHAVIOURAL. safeHref is the shipped artifact, read off disk and
//      actually executed against real inputs. These are real tests.
//   2. WIRING. public/app.js touches the DOM at top level, so it cannot be
//      evaluated outside a browser without adding a DOM harness dependency
//      this project does not carry. The assertions that the renderer and the
//      modal CALL the guard are therefore source-level, and a source
//      assertion proves a string is present, never that the code runs. Every
//      one of them carries a positive control so a matcher that has stopped
//      matching anything fails loudly instead of reading as a pass.
//
// The class guard at the bottom is the part that survives us: it enumerates
// every interpolated href in app.js and fails when a new one appears, so the
// next unguarded link sink trips a test instead of shipping.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const guardSrc = readFileSync(join(HERE, "../public/url-safety.js"), "utf8");
const appSrc = readFileSync(join(HERE, "../public/app.js"), "utf8");
const indexSrc = readFileSync(join(HERE, "../public/index.html"), "utf8");

// Evaluate the SHIPPED guard file in a fake window, exactly as a browser
// would run it: an IIFE that assigns onto window. Nothing is reimplemented
// here, so a change to the shipped file changes what these tests measure.
function loadGuard(): (raw: unknown) => string {
  const fakeWindow: Record<string, unknown> = {};
  new Function("window", guardSrc)(fakeWindow);
  const fn = fakeWindow.safeHref;
  // Refuse rather than skip. If the guard were renamed or its file emptied,
  // every assertion below would otherwise pass against undefined behaviour
  // and this suite would report green about a guard that is not there.
  if (typeof fn !== "function") {
    throw new Error(
      "public/url-safety.js did not define window.safeHref. The suite cannot " +
        "test a guard it could not load; fix the extractor or the file, do " +
        "not weaken this check.",
    );
  }
  return fn as (raw: unknown) => string;
}

describe("public/url-safety.js loads", () => {
  it("is non-empty and defines window.safeHref", () => {
    expect(guardSrc.length).toBeGreaterThan(0);
    expect(typeof loadGuard()).toBe("function");
  });
});

describe("safeHref refuses non-web schemes", () => {
  const safeHref = loadGuard();

  // The case the guard exists for. escapeHtml() leaves this string untouched
  // because it contains none of & < > " ' -- which is why escaping alone was
  // never sufficient on an href.
  it("refuses javascript:", () => {
    expect(safeHref("javascript:alert(1)")).toBe("#");
  });

  // Scheme comparison is case-insensitive in the URL parser. A naive
  // startsWith("javascript:") check passes this one straight through.
  it("refuses javascript: regardless of case", () => {
    expect(safeHref("JavaScript:alert(1)")).toBe("#");
    expect(safeHref("JAVASCRIPT:alert(1)")).toBe("#");
  });

  // The variant that makes parsing non-negotiable: the URL parser removes
  // embedded tab/LF/CR before resolving the scheme, so this IS javascript:
  // to a browser while being a different string to any line-based matcher.
  it("refuses javascript: with embedded control characters", () => {
    expect(safeHref("java\nscript:alert(1)")).toBe("#");
    expect(safeHref("java\tscript:alert(1)")).toBe("#");
    expect(safeHref("java\rscript:alert(1)")).toBe("#");
  });

  // Leading whitespace is stripped by the parser for the same reason.
  it("refuses javascript: behind leading whitespace", () => {
    expect(safeHref("  javascript:alert(1)")).toBe("#");
    expect(safeHref("\njavascript:alert(1)")).toBe("#");
  });

  it("refuses data:, vbscript:, blob: and file:", () => {
    expect(safeHref("data:text/html,<h1>x</h1>")).toBe("#");
    expect(safeHref("vbscript:msgbox(1)")).toBe("#");
    expect(safeHref("blob:https://example.com/abc")).toBe("#");
    expect(safeHref("file:///etc/passwd")).toBe("#");
  });

  it("refuses empty, blank, and non-string input", () => {
    expect(safeHref("")).toBe("#");
    expect(safeHref("   ")).toBe("#");
    expect(safeHref(null)).toBe("#");
    expect(safeHref(undefined)).toBe("#");
    expect(safeHref(42)).toBe("#");
    expect(safeHref({ toString: () => "https://example.com" })).toBe("#");
  });

  it("refuses relative references rather than resolving them against a base", () => {
    expect(safeHref("/api/artifact/x")).toBe("#");
    expect(safeHref("example.com")).toBe("#");
  });
});

// THE POSITIVE CONTROL FOR THE WHOLE GUARD. Without this block a safeHref
// that returned "#" unconditionally would satisfy every assertion above, and
// a guard that refuses everything reads exactly like a guard that works
// while silently breaking every real web-search citation in the transcript.
describe("safeHref permits real web URLs (positive control)", () => {
  const safeHref = loadGuard();

  it("returns http and https URLs unchanged", () => {
    const cases = [
      "https://en.wikipedia.org/?curid=12345",
      "http://example.com/a/b?c=d#e",
      "https://example.com/path%20with%20escape",
      "https://user:pass@example.com:8443/x",
    ];
    for (const c of cases) expect(safeHref(c)).toBe(c);
  });

  // Returned unchanged, NOT normalised: the href and the link text rendered
  // beside it must stay byte-identical, and escapeHtml downstream is what
  // handles a quote inside an otherwise legitimate URL.
  it("does not normalise the value it accepts", () => {
    const raw = "https://example.com/a//b/../c?z=1&y=2";
    expect(safeHref(raw)).toBe(raw);
    expect(safeHref(raw)).not.toBe(new URL(raw).href);
  });
});

describe("wiring: the transcript renderer calls the guard", () => {
  // Positive control first: prove the matcher can find the sink at all, so a
  // renamed CSS class or a reflowed template cannot turn a broken search into
  // a silent pass on the assertion below.
  it("the retrieved-web link sink is findable in app.js", () => {
    expect(appSrc).toMatch(/class="rc-text"><a href=/);
  });

  it("the retrieved-web href is passed through safeHref", () => {
    expect(appSrc).toMatch(/class="rc-text"><a href="\$\{escapeHtml\(window\.safeHref\(/);
  });

  // Both guards, not one. escapeHtml answers "can this break out of the
  // attribute", safeHref answers "what does this navigate to", and dropping
  // either leaves a real hole.
  it("keeps escapeHtml on the same sink", () => {
    expect(appSrc).toMatch(/href="\$\{escapeHtml\(window\.safeHref\(c\.url\)\)\}"/);
  });

  it("index.html loads url-safety.js before app.js", () => {
    const guardAt = indexSrc.indexOf("/url-safety.js");
    const appAt = indexSrc.indexOf("/app.js");
    expect(guardAt).toBeGreaterThan(-1);
    expect(appAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(appAt);
  });
});

describe("wiring: the credential modal clears its inputs on every close path", () => {
  // Extract closeGatewayModal's body rather than searching the whole file,
  // so a clear that happens somewhere else entirely cannot satisfy this.
  function closeGatewayModalBody(): string {
    const m = appSrc.match(/function closeGatewayModal\(\)\s*\{([\s\S]*?)\n\}/);
    if (!m) {
      throw new Error(
        "could not locate closeGatewayModal in public/app.js; the extractor " +
          "is stale and this suite would otherwise assert nothing",
      );
    }
    return m[1];
  }

  it("the extractor finds a non-empty function body (control)", () => {
    expect(closeGatewayModalBody().trim().length).toBeGreaterThan(0);
  });

  it("clears the AI Gateway token input", () => {
    expect(closeGatewayModalBody()).toMatch(/gatewayModalToken\.value = ""/);
  });

  it("clears the control-plane key input", () => {
    expect(closeGatewayModalBody()).toMatch(/gatewayModalCpKey\.value = ""/);
  });

  // The reason the clear lives in closeGatewayModal rather than at the call
  // sites: every dismissal routes through it (save success, cancel button,
  // backdrop, the X affordance, Escape). Assert that stays true, because the
  // structural property is what makes the fix hold rather than five edits.
  it("every gateway-modal dismissal still routes through closeGatewayModal", () => {
    const closers = appSrc.match(/closeGatewayModal\(\)/g) || [];
    // 1 declaration + save-success + cancel listener + data-modal-close + Escape
    expect(closers.length).toBeGreaterThanOrEqual(4);
    expect(appSrc).toMatch(/modalId === "gateway-modal"\) closeGatewayModal\(\)/);
    expect(appSrc).toMatch(/gatewayModalCancel\.addEventListener\("click", closeGatewayModal\)/);
    expect(appSrc).toMatch(/!gatewayModal\.hidden\) closeGatewayModal\(\)/);
  });
});

// CLASS GUARD. The point of this block is the NEXT link sink, not this one.
// Enumerate every interpolated href in app.js and require each to be
// accounted for; a new one fails here and forces whoever adds it to say
// which category it is in, rather than inheriting escaping-only by default.
describe("class guard: every interpolated href in app.js is accounted for", () => {
  const hrefExprs = [...appSrc.matchAll(/href="\$\{([^}]*(?:\}[^"]*)*?)\}"/g)].map(
    (m) => m[1],
  );

  it("the enumerator finds the hrefs it is supposed to (control)", () => {
    // A zero here means the matcher broke, not that the file is clean.
    expect(hrefExprs.length).toBeGreaterThan(0);
  });

  it("finds exactly the four known interpolated hrefs", () => {
    // Three artifact download links plus the one web-search citation. Raise
    // this number only together with a decision about the new sink.
    expect(hrefExprs.length).toBe(4);
  });

  it("each is either an internally-constructed artifact URL or scheme-guarded", () => {
    for (const expr of hrefExprs) {
      const isArtifact = /escapeHtml\(url\)/.test(expr);
      const isGuarded = /window\.safeHref\(/.test(expr);
      expect(
        isArtifact || isGuarded,
        `unaccounted href interpolation: \${${expr}} -- an href built from a ` +
          "value this worker did not construct needs window.safeHref, not " +
          "escapeHtml alone",
      ).toBe(true);
    }
  });
});
