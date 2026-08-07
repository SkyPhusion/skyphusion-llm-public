// The version this Worker advertises must equal the version in package.json.
//
// THE EXPECTED VALUE IS DERIVED, NEVER TRANSCRIBED. This file reads package.json off disk and
// parses it; it does not carry a second hand-typed copy of the version string. That distinction
// is the whole reason this test is worth having. In prism-mcp the advertised version was a
// literal and the test asserting it carried a transcribed duplicate of the same string, so the
// assertion only ever proved that someone had typed the same thing twice -- and a correct
// version bump went red because one copy was updated and the other was not.
//
// SCOPE: this file owns "the literal agrees with package.json". Whether the Worker actually PUTS
// that value on the wire is a separate failure mode, asserted against the real fetch handler in
// tests-integration/worker.test.ts. Two assertions, two mutations: breaking the literal reddens
// this file and leaves the integration suite green; removing the field from the /health payload
// reddens the integration suite and leaves this file green. That pairing is what proves they are
// two assertions rather than one check wearing two names.
//
// This lives in the NODE project (vitest.node.config.ts) rather than the workers one because it
// reads the filesystem, which workerd has no business doing. The split is load-bearing for the
// pairing above, not incidental.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version";

// Anchored to THIS FILE, not to process.cwd(): a suite run from a scratch worktree must read the
// package.json that sits beside the source it is asserting about, not whichever one the working
// directory happens to point at.
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };

describe("advertised version", () => {
  // POSITIVE CONTROL, and it runs first on purpose: if package.json moved, was renamed, or
  // stopped parsing, `pkg.version` is undefined and every assertion below would compare against
  // nothing. An undefined expected value makes a drift test fail for a reason that has nothing to
  // do with drift, so name that failure separately rather than letting it wear drift's clothes. A
  // broken reader must not be able to look like either a pass or a version mismatch.
  it("reads a real version out of package.json (control: the reader is not blind)", () => {
    expect(pkg.name).toBe("prism");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("matches package.json, so a release bump cannot leave the wire behind", () => {
    expect(VERSION).toBe(pkg.version);
  });
});
