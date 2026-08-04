// Tests for OpenAI Responses API body builder (v0.173.0).

import { describe, it, expect } from "vitest";
import { buildOpenAIResponsesBody } from "../src/providers/openai";
import { MODELS } from "../src/models";

describe("buildOpenAIResponsesBody", () => {
  it("maps system to instructions and user/assistant to input", () => {
    const body = buildOpenAIResponsesBody([
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" },
    ]);
    expect(body.instructions).toBe("be brief");
    expect(body.input).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" },
    ]);
    expect(body.max_output_tokens).toBe(4096);
    expect(body.stream).toBeUndefined();
    expect(body.messages).toBeUndefined();
  });

  it("flattens multimodal text blocks and drops image_url parts", () => {
    const body = buildOpenAIResponsesBody([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
          { type: "text", text: "please" },
        ],
      },
    ]);
    expect(body.input).toEqual([{ role: "user", content: "look\nplease" }]);
  });

  it("sets stream:true when requested", () => {
    const body = buildOpenAIResponsesBody(
      [{ role: "user", content: "x" }],
      { stream: true, maxOutputTokens: 512 },
    );
    expect(body.stream).toBe(true);
    expect(body.max_output_tokens).toBe(512);
  });

  it("omits instructions when no system message is present", () => {
    const body = buildOpenAIResponsesBody([{ role: "user", content: "only user" }]);
    expect(body.instructions).toBeUndefined();
  });
});

describe("catalog responses models", () => {
  const ids = [
    "openai/gpt-5.5-pro",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-luna",
  ];

  for (const id of ids) {
    it(`${id} is openai chat with api:responses and streaming`, () => {
      const m = MODELS.find((x) => x.id === id);
      expect(m).toBeDefined();
      expect(m?.provider).toBe("openai");
      expect(m?.type).toBe("chat");
      expect(m?.streaming).toBe(true);
      expect(m?.api).toBe("responses");
    });
  }

  it("gpt-5.5 stays on Chat Completions (no api flag)", () => {
    const m = MODELS.find((x) => x.id === "openai/gpt-5.5");
    expect(m?.api).toBeUndefined();
  });
});
