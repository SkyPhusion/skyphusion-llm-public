// The zero-join retrieval diagnostic (skyphusion-labs/fleet-chezmoi#1608).
//
// retrieveContext queries Vectorize globally -- no metadata filter, because the
// tenant scope is the D1 join (see the design note above retrieveContext, which
// is deliberate: it avoids requiring a Vectorize metadata index). So the raw
// Vectorize result legitimately contains vector ids belonging to other tenants,
// and vector ids are minted as `${userEmail}:${docId}:${chunkIndex}`.
//
// That makes the zero-join branch the one place where foreign identifiers are
// in scope next to a string that gets returned to the caller. These assert the
// split: the operator log keeps the full diagnostic, the client half carries
// nothing derived from the shared index.
//
// Only env.AI / env.VEC / env.DB are stubbed -- the un-stubbable seams.
// Everything between them is the real shipped retrieveContext.

import { describe, it, expect, vi, afterEach } from "vitest";
import { retrieveContext } from "../src/routes/rag";
import type { Env } from "../src/env";

const CALLER = "alice@example.com";
const FOREIGN_IDS = [
  "victim@example.com:7:0",
  "usr_0123456789abcdef01234567:12:3",
  "bob@example.com:99:2",
];

// A caller-visible string must contain none of these substrings. Kept as the
// identity half of the vector id rather than the whole id, so the assertion
// still fires if only the identity survives some future re-formatting.
const FOREIGN_IDENTITIES = ["victim@example.com", "usr_0123456789abcdef01234567", "bob@example.com"];

function fakeEnv(): Env {
  return {
    AI: {
      run: async () => ({ shape: [1, 3], data: [[0.1, 0.2, 0.3]] }),
    },
    VEC: {
      query: async () => ({
        matches: FOREIGN_IDS.map((id, i) => ({ id, score: 0.9 - i * 0.01 })),
      }),
    },
    DB: {
      prepare(sql: string) {
        const isPrefs = sql.includes("user_prefs");
        return {
          bind() {
            return {
              // loadUserPrefs -> gateway credentials, so embedBatch proceeds.
              async first() {
                return isPrefs ? { prefs_json: JSON.stringify({ gateway_id: "alice-gw" }) } : null;
              },
              // The tenant-scoped join finds none of the foreign vectors,
              // which is the branch under test.
              async all() {
                return { results: [] };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retrieveContext zero-join diagnostic", () => {
  it("returns a caller-visible message carrying no foreign identity", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { chunks, error } = await retrieveContext(fakeEnv(), CALLER, "quarterly revenue");

    expect(chunks).toEqual([]);

    // ORDER IS LOAD-BEARING. Do not swap these two blocks.
    //
    // The disclosure assertion runs FIRST so that it is the assertion that
    // fires when the defect is present. With the pin first, driving the
    // pre-fix code (888e6bb reversed) reddened this test on the pin's
    // `toBe` line and short-circuited, so the loop below never executed:
    // the suite detected the defect, but the assertion that names it had
    // never been shown capable of failing.
    for (const identity of FOREIGN_IDENTITIES) {
      expect(error).not.toContain(identity);
    }

    // Pin the exact branch SECOND. This is the anti-vacuity control: on any
    // earlier failure path ("embed failed: ...", "vectorize query failed:
    // ...") the loop above passes for free, because those strings are also
    // free of foreign identities and are not the case under test. Running it
    // after preserves that guarantee while leaving the loop reachable.
    expect(error).toBe("No indexed documents matched the query.");

    // Control: the harness really did feed foreign ids in, so the absence
    // above is a redaction rather than an empty input.
    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    for (const identity of FOREIGN_IDENTITIES) {
      expect(logged).toContain(identity);
    }
  });

  it("keeps the operator diagnostic intact, not deleted", async () => {
    // The diagnostic is the thing that makes a silent retrieval failure
    // debuggable. The fix is a split, not a removal, and this is what would
    // fail if a later cleanup "simplified" the console.warn away.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await retrieveContext(fakeEnv(), CALLER, "quarterly revenue");

    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("sample vector_ids=[");
    expect(logged).toContain("D1 join returned 0");
    expect(logged).toContain(CALLER);
  });

  it("scopes the project-filtered message the same way", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { error } = await retrieveContext(fakeEnv(), CALLER, "quarterly revenue", 5, 42);

    // Same ordering rule as above: disclosure assertion first so it is
    // reachable under the defect, branch pin second as the anti-vacuity
    // control.
    for (const identity of FOREIGN_IDENTITIES) {
      expect(error).not.toContain(identity);
    }
    expect(error).toBe("No indexed documents in this project matched the query.");
    expect(warn).toHaveBeenCalled();
  });

  it("harness control: the fixture really does supply foreign ids", () => {
    // If FOREIGN_IDS were ever emptied, every not-toContain assertion above
    // would pass while testing nothing.
    expect(FOREIGN_IDS.length).toBeGreaterThan(0);
    expect(FOREIGN_IDENTITIES.length).toBe(FOREIGN_IDS.length);
    for (const id of FOREIGN_IDS) {
      expect(id).toContain(":");
      expect(id.split(":")[0]).not.toBe(CALLER);
    }
  });
});
