// Tests for buildProxiedImageParams (v0.22.0).
//
// The proxied image models each have an additionalProperties:false schema, so
// the load-bearing property is that each provider gets ONLY its accepted keys
// and never the @cf shape (width/height/steps/negative_prompt). The openai
// case is the one that matters most: it must carry background:"transparent"
// (the whole reason gpt-image-1.5 was added) plus a transparency-capable
// output_format.

import { describe, it, expect } from "vitest";
import { buildProxiedImageParams } from "../src/proxied-image-params";

describe("buildProxiedImageParams", () => {
  it("google (nano-banana) sends prompt + png output_format only", () => {
    expect(buildProxiedImageParams("google", "a coin")).toEqual({
      prompt: "a coin",
      output_format: "png",
    });
  });

  it("openai (gpt-image-1.5) sends only proxy-valid fields (opaque; proxy rejects background/output_format)", () => {
    const params = buildProxiedImageParams("openai", "a coin sprite");
    expect(params).toEqual({ prompt: "a coin sprite", quality: "high", size: "1024x1024" });
    // The proxy 7003-rejects these; they must NOT be sent on this path.
    expect("background" in params).toBe(false);
    expect("output_format" in params).toBe(false);
  });

  it("recraft (recraftv4*) sends bare prompt (no style/size; V4.1 Pro rejects 1024x1024)", () => {
    const params = buildProxiedImageParams("recraft", "a logo");
    expect(params).toEqual({ prompt: "a logo" });
    expect("style" in params).toBe(false);
    expect("size" in params).toBe(false);
    expect("background" in params).toBe(false);
  });

  it("xai (grok-imagine-*) requests b64_json (Unified Billing ZDR/URL ban, v0.173.0)", () => {
    expect(buildProxiedImageParams("xai", "a puppy")).toEqual({
      prompt: "a puppy",
      response_format: "b64_json",
    });
  });

  it("bytedance (seedream-5-pro) sends bare prompt only (v0.171.0)", () => {
    expect(buildProxiedImageParams("bytedance", "a watch")).toEqual({ prompt: "a watch" });
  });

  it("never leaks the @cf request shape for any proxied provider", () => {
    for (const p of ["google", "openai", "recraft", "xai", "bytedance"] as const) {
      const params = buildProxiedImageParams(p, "x");
      for (const forbidden of ["width", "height", "steps", "negative_prompt"]) {
        expect(forbidden in params).toBe(false);
      }
    }
  });

  it("falls back to a bare prompt for an unknown/undefined provider", () => {
    expect(buildProxiedImageParams(undefined, "x")).toEqual({ prompt: "x" });
  });
});
