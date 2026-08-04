// OpenAI SSE interpreter (v0.21.0; Responses API stream events v0.173.0).
//
// OpenAI models are proxied through Cloudflare Unified Billing via
// env.AI.run("openai/<model>", ...). Empirically the binding can hand back
// several known frame shapes; which one is not contractually documented:
//
//   1. Chat Completions native delta:
//        { "choices": [{ "delta": { "content": "..." } }], "usage"?: {...} }
//   2. CF-normalized flat (same shape Workers AI hosted models emit):
//        { "response": "...", "usage"?: {...} }
//   3. Responses API typed events (v0.173.0):
//        { "type": "response.output_text.delta", "delta": "..." }
//        { "type": "response.completed", "response": { "usage": {...} } }
//
// Rather than guess which one the proxy uses (and ship a parser that silently
// yields empty output if the guess is wrong), this interpreter handles all of
// them. The shapes don't collide on the fields we read. If a future fourth
// shape appears, add a branch here with a fixture test.
//
// `data: [DONE]` is dropped by the SSE framer before frames reach here. Empty
// content/response strings (normal on the trailing usage frame) are dropped.
// Usage naming is accepted in both Chat Completions
// (prompt_tokens/completion_tokens) and Responses
// (input_tokens/output_tokens) forms.

import type { ProviderStreamEvent } from "./types";

export function interpretOpenAISSEFrame(data: unknown): ProviderStreamEvent[] {
  const events: ProviderStreamEvent[] = [];
  if (!data || typeof data !== "object") return events;
  const d = data as {
    type?: string;
    delta?: unknown;
    choices?: Array<{ delta?: { content?: string } }>;
    response?: unknown;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
  };

  // Shape 3: Responses API typed events.
  if (d.type === "response.output_text.delta") {
    if (typeof d.delta === "string" && d.delta.length > 0) {
      events.push({ type: "text", text: d.delta });
    }
  } else if (d.type === "response.completed") {
    const resp = d.response as {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
      };
    } | undefined;
    const u = resp?.usage;
    if (u) {
      events.push({
        type: "usage",
        in_: u.prompt_tokens ?? u.input_tokens ?? null,
        out_: u.completion_tokens ?? u.output_tokens ?? null,
      });
    }
  }

  // Shape 1: Chat Completions native delta.
  const delta = d.choices?.[0]?.delta?.content;
  if (typeof delta === "string" && delta.length > 0) {
    events.push({ type: "text", text: delta });
  }

  // Shape 2: CF-normalized flat `response` (string only; object form is
  // Responses completed envelope, handled above).
  if (typeof d.response === "string" && d.response.length > 0) {
    events.push({ type: "text", text: d.response });
  }

  if (d.usage) {
    events.push({
      type: "usage",
      in_: d.usage.prompt_tokens ?? d.usage.input_tokens ?? null,
      out_: d.usage.completion_tokens ?? d.usage.output_tokens ?? null,
    });
  }

  return events;
}
