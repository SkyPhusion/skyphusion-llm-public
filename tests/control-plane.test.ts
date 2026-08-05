import { describe, expect, it } from "vitest";
import {
  looksLikeClientKey,
  resolveControlPlane,
  allowlistedControlPlaneOrigin,
  stripTrailingSlashes,
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

describe("stripTrailingSlashes", () => {
  it("strips without regex ReDoS surface", () => {
    expect(stripTrailingSlashes("https://play-proxy.skyphusion.org///")).toBe(
      "https://play-proxy.skyphusion.org",
    );
    expect(stripTrailingSlashes("abc")).toBe("abc");
  });
});

describe("allowlistedControlPlaneOrigin", () => {
  it("accepts the production host only", () => {
    expect(allowlistedControlPlaneOrigin(DEFAULT_CONTROL_PLANE_URL)).toBe(
      "https://play-proxy.skyphusion.org",
    );
    expect(allowlistedControlPlaneOrigin("https://PLAY-PROXY.SKYPHUSION.ORG/")).toBe(
      "https://play-proxy.skyphusion.org",
    );
  });

  it("rejects SSRF targets and lookalikes", () => {
    expect(allowlistedControlPlaneOrigin("https://evil.example")).toBeNull();
    expect(allowlistedControlPlaneOrigin("https://play-proxy.skyphusion.org.evil.com")).toBeNull();
    expect(allowlistedControlPlaneOrigin("http://play-proxy.skyphusion.org")).toBeNull();
    expect(allowlistedControlPlaneOrigin("https://169.254.169.254")).toBeNull();
    expect(allowlistedControlPlaneOrigin("https://play-proxy.skyphusion.org/v1")).toBeNull();
    expect(allowlistedControlPlaneOrigin("https://user:pass@play-proxy.skyphusion.org")).toBeNull();
  });

  it("allows localhost only when opted in", () => {
    expect(allowlistedControlPlaneOrigin("http://localhost:8787")).toBeNull();
    expect(
      allowlistedControlPlaneOrigin("http://localhost:8787", { allowLocalhost: true }),
    ).toBe("http://localhost:8787");
  });
});

describe("resolveControlPlane", () => {
  it("returns null without a valid key", () => {
    expect(resolveControlPlane(null)).toBeNull();
    expect(resolveControlPlane({ control_plane_key: "nope" })).toBeNull();
  });

  it("uses allowlisted default URL; ignores any prefs URL field", () => {
    const key = `pcp_${"b".repeat(16)}_${"B".repeat(43)}`;
    const cp = resolveControlPlane({
      control_plane_key: key,
      // @ts-expect-error legacy / hostile field must not be honored
      control_plane_url: "https://evil.example",
    });
    expect(cp?.baseUrl).toBe(DEFAULT_CONTROL_PLANE_URL);
    expect(cp?.clientKey).toBe(key);
  });

  it("refuses a non-allowlisted CONTROL_PLANE_URL env", () => {
    const key = `pcp_${"c".repeat(16)}_${"C".repeat(43)}`;
    expect(
      resolveControlPlane(
        { control_plane_key: key },
        { CONTROL_PLANE_URL: "https://evil.example" },
      ),
    ).toBeNull();
  });
});

describe("controlPlaneChat", () => {
  it("posts OpenAI-shaped body with bearer to fixed path", async () => {
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
      { baseUrl: "https://play-proxy.skyphusion.org", clientKey: key },
      { model: "@cf/meta/llama-3.2-3b-instruct", messages: [{ role: "user", content: "hi" }] },
      fetchImpl as typeof fetch,
    );
    expect(result.text).toBe("hello from proxy");
    expect(result.requestId).toBe("req_test");
    expect(seen!.url).toBe("https://play-proxy.skyphusion.org/v1/chat/completions");
    expect(seen!.headers.get("authorization")).toBe(`Bearer ${key}`);
  });
});
