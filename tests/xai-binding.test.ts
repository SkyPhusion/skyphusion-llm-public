// Tests for the v0.170.0 binding dispatch in src/providers/xai.ts.
//
// xai/grok-4.5 is flagged binding: true, so callXai / callXaiStream route
// through env.AI.run (Unified Billing catalog) instead of the legacy AI Gateway
// grok provider fetch. Mirrors tests/anthropic-binding.test.ts.

import { describe, it, expect } from "vitest";
import type { AiContext } from "../src/ai-binding";
import type { ModelEntry } from "../src/models";
import { MODELS } from "../src/models";
import { callXai, callXaiStream } from "../src/providers/xai";
import type { ProviderStreamEvent } from "../src/parsers/types";

const grok45: ModelEntry = {
  id: "xai/grok-4.5",
  label: "Grok 4.5 (xAI)",
  group: "Chat · xAI",
  type: "chat",
  capabilities: ["vision"],
  provider: "xai",
  streaming: true,
  binding: true,
};

type RunCall = { model: string; params: Record<string, unknown>; opts: unknown };

function fakeCtx(runImpl: (model: string, params: unknown, opts: unknown) => Promise<unknown>): { ctx: AiContext; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const env = {
    AI: {
      run: (model: string, params: unknown, opts: unknown) => {
        calls.push({ model, params: params as Record<string, unknown>, opts });
        return runImpl(model, params, opts);
      },
      aiGatewayLogId: "log-xai-123",
    },
  } as unknown as AiContext["env"];
  const ctx = { env, gateway: { gatewayId: "skyphusion-llm", cfAigToken: "tok" } } as unknown as AiContext;
  return { ctx, calls };
}

function sseStream(frames: unknown[], chunkSize = 11): ReadableStream<Uint8Array> {
  const text = frames.map((f) => "data: " + JSON.stringify(f) + "\n\n").join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= bytes.length) { controller.close(); return; }
      const end = Math.min(i + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(i, end));
      i = end;
    },
  });
}

const userMessages = [{ role: "user", content: "hi" }];

describe("catalog", () => {
  it("has grok-4.5 flagged binding: true, provider xai, streaming, vision", () => {
    const m = MODELS.find((x) => x.id === "xai/grok-4.5");
    expect(m).toBeDefined();
    expect(m?.binding).toBe(true);
    expect(m?.provider).toBe("xai");
    expect(m?.streaming).toBe(true);
    expect(m?.capabilities).toContain("vision");
  });
});

describe("callXai binding dispatch (non-stream)", () => {
  const completion = {
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  };

  it("calls env.AI.run with the full catalog id and Chat Completions body", async () => {
    const { ctx, calls } = fakeCtx(async () => completion);
    const { raw, logId } = await callXai(ctx, grok45, userMessages);

    expect(raw).toBe(completion);
    expect(logId).toBe("log-xai-123");
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("xai/grok-4.5");
    expect(calls[0].opts).toEqual({ gateway: { id: "skyphusion-llm" } });

    const p = calls[0].params;
    expect(p.messages).toEqual(userMessages);
    expect(p.max_completion_tokens).toBe(4096);
    expect(p.stream).toBeUndefined();
    // Binding path does not strip the xai/ prefix into a separate model field.
    expect(p.model).toBeUndefined();
  });

  it("a non-binding xai model does NOT take the binding path", async () => {
    const { ctx, calls } = fakeCtx(async () => completion);
    const legacy: ModelEntry = { ...grok45, id: "xai/grok-4.3", binding: undefined };
    await expect(callXai(ctx, legacy, userMessages)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("callXaiStream binding dispatch", () => {
  it("streams OpenAI-compatible SSE through interpretXaiSSEFrame", async () => {
    const frames = [
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } },
    ];
    const { ctx, calls } = fakeCtx(async () => sseStream(frames));
    const ac = new AbortController();
    const events: ProviderStreamEvent[] = [];
    for await (const e of callXaiStream(ctx, grok45, userMessages, ac.signal)) {
      events.push(e);
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("xai/grok-4.5");
    expect(calls[0].params.stream).toBe(true);
    expect(calls[0].params.stream_options).toEqual({ include_usage: true });
    expect(events).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "usage", in_: 2, out_: 2 },
    ]);
  });
});
