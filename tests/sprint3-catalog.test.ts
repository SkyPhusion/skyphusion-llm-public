// Catalog pins for the v0.172.0 Sprint 3 image-sibling adds (data-only).

import { describe, it, expect } from "vitest";
import { MODELS } from "../src/models";

describe("v0.172.0 sprint 3 catalog entries", () => {
  const cases: Array<{ id: string; provider: string }> = [
    { id: "google/nano-banana-2-lite", provider: "google" },
    { id: "recraft/recraftv4-1", provider: "recraft" },
    { id: "xai/grok-imagine-image-quality", provider: "xai" },
    { id: "bytedance/seedream-5-lite", provider: "bytedance" },
  ];

  for (const c of cases) {
    it(`adds ${c.id} as ${c.provider} image`, () => {
      const m = MODELS.find((x) => x.id === c.id);
      expect(m).toBeDefined();
      expect(m?.provider).toBe(c.provider);
      expect(m?.type).toBe("image");
    });
  }

  it("keeps pro/base siblings alongside the new tier rows", () => {
    expect(MODELS.find((x) => x.id === "google/nano-banana-2")).toBeDefined();
    expect(MODELS.find((x) => x.id === "recraft/recraftv4-1-pro")).toBeDefined();
    expect(MODELS.find((x) => x.id === "xai/grok-imagine-image")).toBeDefined();
    expect(MODELS.find((x) => x.id === "bytedance/seedream-5-pro")).toBeDefined();
  });
});
