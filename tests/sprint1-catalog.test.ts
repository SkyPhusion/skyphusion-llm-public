// Catalog pins for the v0.170.0 Sprint 1 model adds (read-only audit follow-up).

import { describe, it, expect } from "vitest";
import { MODELS } from "../src/models";

describe("v0.170.0 sprint 1 catalog entries", () => {
  it("adds Gemini 3.6 Flash on the google dispatcher (text-only caps)", () => {
    const m = MODELS.find((x) => x.id === "google/gemini-3.6-flash");
    expect(m).toBeDefined();
    expect(m?.provider).toBe("google");
    expect(m?.type).toBe("chat");
    expect(m?.streaming).toBe(true);
    expect(m?.capabilities).toEqual([]);
  });

  it("adds Seedance 2.0 Mini as bytedance video with image-input", () => {
    const m = MODELS.find((x) => x.id === "bytedance/seedance-2.0-mini");
    expect(m).toBeDefined();
    expect(m?.provider).toBe("bytedance");
    expect(m?.type).toBe("video");
    expect(m?.capabilities).toContain("image-input");
  });

  it("does not re-introduce blocked grok-build-0.1", () => {
    expect(MODELS.find((x) => x.id === "xai/grok-build-0.1")).toBeUndefined();
  });
});
