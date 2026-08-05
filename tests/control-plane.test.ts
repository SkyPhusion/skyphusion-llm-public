import { describe, expect, it } from "vitest";
import {
  looksLikeClientKey,
  resolveControlPlane,
  controlPlaneChat,
  DEFAULT_CONTROL_PLANE_URL,
} from "../src/control-plane";

describe("looksLikeClientKey", () => {
  it("accepts a well-formed pcp key", () => {
    const key = `pcp_${"a".repeat(16)}_${"A".repeat(43)}`;
    expect(looksLikeClientKey(key)).toBe(true);
  });

  it("rejects junk", () => {
    expect(looksLikeClientKey("pcp_short")).toBe(false);
    expect(looksLikeClientKey("Bearer x")).toBe(false);
  });
});

describe("resolveControlPlane", () => {
  it("returns null without a valid key", () => {
    expect(resolveControlPlane(null)).toBeNull();
    expect(resolveControlPlane({ control_plane_key: "nope" })).toBeNull();
  });

  it("defaults URL and returns credentials", () => {
    const key = `pcp_${"b".repeat(16)}_${"B".repeat(43)}`;
    const cp = resolveControlPlane({ control_plane_key: key });
    expect(cp?.baseUrl).toBe(DEFAULT_CONTROL_PLANE_URL);
    expect(cp?.clientKey).toBe(key);
  });

  it("strips trailing slash on URL", () => {
    const key = `pcp_${"c".repeat(16)}_${"C".repeat(43)}`;
    const cp = resolveControlPlane({
      control_plane_key: key,
      control_plane_url: "https://play-proxy.skyphusion.org/",
    });
    expect(cp?.baseUrl).toBe("https://play-proxy.skyphusion.org");
  });
});

describe("controlPlaneChat", () => {
  it("posts OpenAI-shaped body with bearer", async () => {
    const key = `pcp_${"d".repeat(16)}_${"D".repeat(43)}`;
    let seen: Request | null = null;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Request(input, init);
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "hello from proxy" } }],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
          model: "m",
        }),
        { status: 200, headers: { "prism-request-id": "req_test" } },
      );
    };
    const result = await controlPlaneChat(
      { baseUrl: "https://play-proxy.example", clientKey: key },
      { model: "@cf/meta/llama-3.2-3b-instruct", messages: [{ role: "user", content: "hi" }] },
      fetchImpl as typeof fetch,
    );
    expect(result.text).toBe("hello from proxy");
    expect(result.requestId).toBe("req_test");
    expect(seen).not.toBeNull();
    expect(seen!.headers.get("authorization")).toBe(`Bearer ${key}`);
    const body = JSON.parse(await seen!.clone().text());
    expect(body.stream).toBe(false);
    expect(body.model).toContain("llama");
  });
});
