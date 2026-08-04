// OpenAI proxied chat via Cloudflare Unified Billing (v0.21.0; Responses API v0.173.0).
//
// Two request surfaces, selected by ModelEntry.api:
//   - "chat" (default): Chat Completions { messages, stream? }
//   - "responses":      Responses API { input, instructions?, max_output_tokens, stream? }
//
// Both go through env.AI.run (not a direct provider fetch). Streaming parses SSE
// with interpretOpenAISSEFrame, which handles Chat Completions deltas, CF flat
// `response` frames, and Responses API output_text.delta / completed events.

import type { AiContext } from "../ai-binding";
import type { ModelEntry } from "../models";
import type { ProviderStreamEvent } from "../parsers/types";
import { aiRun, aiLogId } from "../ai-binding";
import { extractSSEDataPayloads } from "../parsers/sse-framer";
import { interpretOpenAISSEFrame } from "../parsers/openai-sse";

// Convert OpenAI-style chat messages into a Responses API body.
// System messages become top-level `instructions`; user/assistant become `input`.
// Multimodal content arrays are flattened to text (Responses models ship with
// empty vision caps until multimodal-in is smoked).
export function buildOpenAIResponsesBody(
  messages: Array<unknown>,
  opts: { stream?: boolean; maxOutputTokens?: number } = {},
): Record<string, unknown> {
  let instructions: string | undefined;
  const input: Array<{ role: string; content: string }> = [];

  for (const raw of messages) {
    const msg = raw as { role?: string; content?: unknown };
    if (msg.role === "system") {
      const text = contentToText(msg.content);
      if (text) instructions = instructions ? `${instructions}\n\n${text}` : text;
      continue;
    }
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    input.push({ role: msg.role, content: contentToText(msg.content) });
  }

  const body: Record<string, unknown> = {
    input,
    max_output_tokens: opts.maxOutputTokens ?? 4096,
  };
  if (instructions) body.instructions = instructions;
  if (opts.stream) body.stream = true;
  return body;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = block as { type?: string; text?: string };
      if (b?.type === "text" && typeof b.text === "string") return b.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isResponses(model: ModelEntry): boolean {
  return model.api === "responses";
}

function buildRunParams(
  model: ModelEntry,
  messages: Array<unknown>,
  stream: boolean,
): Record<string, unknown> {
  if (isResponses(model)) {
    return buildOpenAIResponsesBody(messages, { stream, maxOutputTokens: 4096 });
  }
  const body: Record<string, unknown> = { messages };
  if (stream) body.stream = true;
  return body;
}

export async function callOpenAI(
  ctx: AiContext,
  model: ModelEntry,
  messages: Array<unknown>,
): Promise<{ raw: unknown; logId: string | null }> {
  const raw = await aiRun(ctx, model.id, buildRunParams(model, messages, false));
  return { raw, logId: aiLogId(ctx) };
}

export async function* callOpenAIStream(
  ctx: AiContext,
  model: ModelEntry,
  messages: Array<unknown>,
  signal: AbortSignal,
): AsyncGenerator<ProviderStreamEvent> {
  const result = await aiRun(ctx, model.id, buildRunParams(model, messages, true));

  if (!(result instanceof ReadableStream)) {
    throw new Error(`OpenAI proxied model did not return a stream (got ${typeof result}). The binding may not honor stream:true for this model; use POST /api/chat instead.`);
  }

  const reader = result.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const onAbort = () => { try { reader.cancel(); } catch { /* fine */ } };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const { payloads, remainder } = extractSSEDataPayloads(buffer);
      buffer = remainder;

      for (const payload of payloads) {
        let data: unknown;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }
        for (const event of interpretOpenAISSEFrame(data)) yield event;
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* fine */ }
  }
}
