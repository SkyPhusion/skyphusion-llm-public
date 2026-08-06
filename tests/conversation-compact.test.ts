import { describe, expect, it } from "vitest";
import {
  applyCompactToPriorTurns,
  buildCompactSystemBlock,
  formatTurnsForSummary,
  normalizeSummary,
  splitTurnsForCompact,
  COMPACT_SUMMARY_MAX_CHARS,
  DEFAULT_KEEP_RECENT,
} from "../src/conversation-context";

const turns = [
  { user_input: "hi", output: "hello", turn_index: 0 },
  { user_input: "what is 2+2", output: "4", turn_index: 1 },
  { user_input: "and 3+3", output: "6", turn_index: 2 },
  { user_input: "thanks", output: "anytime", turn_index: 3 },
];

describe("splitTurnsForCompact", () => {
  it("keeps the last N raw and summarizes the rest", () => {
    const { summarize, keep } = splitTurnsForCompact(turns, 2);
    expect(summarize.map((t) => t.turn_index)).toEqual([0, 1]);
    expect(keep.map((t) => t.turn_index)).toEqual([2, 3]);
  });

  it("summarizes nothing when keep_recent covers the whole thread", () => {
    const { summarize, keep } = splitTurnsForCompact(turns, 10);
    expect(summarize).toEqual([]);
    expect(keep).toHaveLength(4);
  });

  it("default keep matches DEFAULT_KEEP_RECENT (2)", () => {
    expect(DEFAULT_KEEP_RECENT).toBe(2);
    const { keep } = splitTurnsForCompact(turns, DEFAULT_KEEP_RECENT);
    expect(keep).toHaveLength(2);
  });
});

describe("formatTurnsForSummary", () => {
  it("labels user and assistant and separates turns", () => {
    const text = formatTurnsForSummary(turns.slice(0, 2));
    expect(text).toContain("User:\nhi");
    expect(text).toContain("Assistant:\nhello");
    expect(text).toContain("---");
    expect(text).toContain("what is 2+2");
  });
});

describe("buildCompactSystemBlock", () => {
  it("wraps the summary with markers the model can anchor on", () => {
    const block = buildCompactSystemBlock("User prefers brief answers.");
    expect(block).toMatch(/\[Compacted earlier conversation\]/);
    expect(block).toContain("User prefers brief answers.");
    expect(block).toMatch(/\[End compacted context\]/);
  });

  it("returns empty for blank summary", () => {
    expect(buildCompactSystemBlock("  ")).toBe("");
  });
});

describe("applyCompactToPriorTurns", () => {
  it("without compact state returns all usable turns", () => {
    const ctx = applyCompactToPriorTurns(turns, null);
    expect(ctx.priorTurns).toHaveLength(4);
    expect(ctx.compactBlock).toBeNull();
    expect(ctx.turnIndex).toBe(4);
  });

  it("with compact state drops covered turns and injects the block", () => {
    const ctx = applyCompactToPriorTurns(turns, {
      summary: "Discussed arithmetic; answers were short.",
      through_turn_index: 1,
      keep_recent: 2,
      model: "@cf/meta/llama-3.2-3b-instruct",
      updated_at: "2026-08-06T00:00:00Z",
    });
    expect(ctx.priorTurns.map((t) => t.user_input)).toEqual(["and 3+3", "thanks"]);
    expect(ctx.compactBlock).toContain("Discussed arithmetic");
    expect(ctx.turnIndex).toBe(4);
  });

  it("skips empty/failed turns when building prior pairs", () => {
    const mixed = [
      ...turns,
      { user_input: "oops", output: "", turn_index: 4 },
    ];
    const ctx = applyCompactToPriorTurns(mixed, null);
    expect(ctx.priorTurns).toHaveLength(4);
    // Next index still advances past the empty row's index.
    expect(ctx.turnIndex).toBe(5);
  });
});

describe("normalizeSummary", () => {
  it("trims and truncates oversized summaries", () => {
    expect(normalizeSummary("  short  ")).toBe("short");
    const long = "x".repeat(COMPACT_SUMMARY_MAX_CHARS + 50);
    const out = normalizeSummary(long);
    expect(out.length).toBeLessThanOrEqual(COMPACT_SUMMARY_MAX_CHARS + 30);
    expect(out).toContain("[summary truncated]");
  });
});
