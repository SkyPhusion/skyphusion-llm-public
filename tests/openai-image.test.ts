// Unit tests for OpenAI transparent-PNG BYOK body shape (v0.174.0).
// Network is stubbed; we only assert the request OpenAI receives.

import { describe, it, expect, vi, afterEach } from "vitest";
import { generateOpenAIImage } from "../src/providers/openai-image";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generateOpenAIImage", () => {
  it("POSTs transparent png params to api.openai.com and strips openai/ prefix", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const gen = await generateOpenAIImage("sk-test", "openai/gpt-image-1.5", "a coin");
    expect(gen.mime).toBe("image/png");
    expect(gen.bytes.length).toBeGreaterThan(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      model: "gpt-image-1.5",
      prompt: "a coin",
      size: "1024x1024",
      quality: "high",
      background: "transparent",
      output_format: "png",
    });
  });

  it("surfaces OpenAI error status + message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "billing hard limit" } }), { status: 429 }),
    ));
    await expect(generateOpenAIImage("sk-test", "openai/gpt-image-2", "x"))
      .rejects.toThrow(/OpenAI image API 429: billing hard limit/);
  });
});
