// Catalog pins for the v0.171.0 Sprint 2 model adds.

import { describe, it, expect } from "vitest";
import { MODELS } from "../src/models";

describe("v0.171.0 sprint 2 catalog entries", () => {
  it("adds Kimi K3 as moonshotai chat with streaming (OpenAI-compat path)", () => {
    const m = MODELS.find((x) => x.id === "moonshotai/kimi-k3");
    expect(m).toBeDefined();
    expect(m?.provider).toBe("moonshotai");
    expect(m?.type).toBe("chat");
    expect(m?.streaming).toBe(true);
    // Multimodal-in unsmoked; attach affordance stays off (OpenAI convention).
    expect(m?.capabilities).toEqual([]);
  });

  it("adds Grok Imagine Image as xai image", () => {
    const m = MODELS.find((x) => x.id === "xai/grok-imagine-image");
    expect(m).toBeDefined();
    expect(m?.provider).toBe("xai");
    expect(m?.type).toBe("image");
  });

  it("adds Seedream 5 Pro as bytedance image", () => {
    const m = MODELS.find((x) => x.id === "bytedance/seedream-5-pro");
    expect(m).toBeDefined();
    expect(m?.provider).toBe("bytedance");
    expect(m?.type).toBe("image");
  });

  it("keeps Workers AI Kimi K2.x distinct from third-party K3", () => {
    expect(MODELS.find((x) => x.id === "@cf/moonshotai/kimi-k2.6")).toBeDefined();
    expect(MODELS.find((x) => x.id === "@cf/moonshotai/kimi-k2.7-code")).toBeDefined();
    expect(MODELS.find((x) => x.id === "moonshotai/kimi-k3")).toBeDefined();
  });
});
