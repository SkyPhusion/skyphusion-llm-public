// Per-provider request params for proxied (non-@cf) image models (v0.22.0;
// xAI b64_json + OpenAI BYOK carve-out notes v0.174.0).
//
// Every proxied image schema is additionalProperties:false (verified against
// the CF model pages), so each provider gets ONLY the keys it accepts; the @cf
// { width, height, steps, negative_prompt } shape is rejected by all of them.
//
// Lives in its own module (not inline in index.ts) for the same reason
// output-extract.ts does: index.ts imports cloudflare:workers and can't load
// under the plain-Node vitest pool, so an inline helper wouldn't be unit-
// testable. This takes the two primitives it needs rather than the ModelEntry/
// ChatRequest objects, keeping it free of any Workers-runtime import.
//
//   google    (nano-banana family): { prompt, output_format } -> PNG URL
//   openai    (gpt-image-*):        opaque via proxy
//                                   { prompt, quality, size }. Transparent PNG
//                                   only via OPENAI_API_KEY BYOK (openai-image.ts).
//   recraft   (recraftv4*):         opaque. Returns webp URL. V4/V4.1 reject
//                                   legacy style enums; V4.1 Pro rejects
//                                   1024x1024. Bare { prompt } live-verified
//                                   200 on v4 / v4-1 / v4-1-pro (v0.174.1).
//   xai       (grok-imagine-*):     { prompt, response_format: "b64_json" }
//                                   CF Unified Billing xAI path is ZDR-constrained
//                                   and rejects URL output; base64 is required.
//   bytedance (seedream-*):         { prompt } -> result.images[] URLs
import type { Provider } from "./models";

export function buildProxiedImageParams(
  provider: Provider | undefined,
  prompt: string,
): Record<string, unknown> {
  switch (provider) {
    case "google":
      return { prompt, output_format: "png" };
    case "openai":
      // gpt-image-* via the CF proxy. The proxy's schema is strictly
      // { prompt, images, quality, size, style } and 7003-rejects
      // background/output_format, so transparency is impossible here.
      // Transparent PNGs use OPENAI_API_KEY + generateOpenAIImage instead.
      return { prompt, quality: "high", size: "1024x1024" };
    case "recraft":
      // V4/V4.1 7003 on style digital_illustration / realistic_image.
      // V4.1 Pro 7003 on size 1024x1024 (2048x2048 or default OK).
      // Bare prompt is accepted on v4, v4-1, and v4-1-pro.
      return { prompt };
    case "xai":
      // Unified Billing Grok Imagine rejects URL format on CF's managed
      // credentials ("Zero Data Retention teams do not have access to URL
      // format"). b64_json is the path that works keylessly.
      return { prompt, response_format: "b64_json" };
    case "bytedance":
      return { prompt };
    default:
      return { prompt };
  }
}
