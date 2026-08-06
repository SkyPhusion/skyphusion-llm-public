// Conversation context for multi-turn chat: prior turns + optional compact
// summary (v0.175.7). Pure helpers live here so chat routes and the compact
// endpoint share one assembly rule, and so unit tests cover it without D1.

export const DEFAULT_KEEP_RECENT = 2;
/** Soft cap on stored / injected summary text (chars). */
export const COMPACT_SUMMARY_MAX_CHARS = 12_000;
/** Minimum completed chat turns before compact is useful (keep_recent + 1). */
export const MIN_TURNS_TO_COMPACT = DEFAULT_KEEP_RECENT + 1;

export type ChatTurnRow = {
  user_input: string;
  output: string;
  turn_index: number;
};

export type ConversationCompactState = {
  summary: string;
  through_turn_index: number;
  keep_recent: number;
  model: string;
  updated_at: string;
};

export type PriorContext = {
  /** Raw user/assistant pairs to put on the wire after any compact block. */
  priorTurns: Array<{ user_input: string; output: string }>;
  /** Next turn_index for persistChat. */
  turnIndex: number;
  /** System-prompt block for compacted earlier turns, or null. */
  compactBlock: string | null;
  compact: ConversationCompactState | null;
};

/** Split turns into those summarized vs kept raw. */
export function splitTurnsForCompact(
  turns: ChatTurnRow[],
  keepRecent: number,
): { summarize: ChatTurnRow[]; keep: ChatTurnRow[] } {
  const k = Math.max(0, Math.floor(keepRecent));
  if (turns.length === 0) return { summarize: [], keep: [] };
  if (k === 0) return { summarize: turns.slice(), keep: [] };
  if (turns.length <= k) return { summarize: [], keep: turns.slice() };
  return {
    summarize: turns.slice(0, turns.length - k),
    keep: turns.slice(turns.length - k),
  };
}

/** Flatten turns into a plain transcript the summarizer model can read. */
export function formatTurnsForSummary(turns: ChatTurnRow[]): string {
  const parts: string[] = [];
  for (const t of turns) {
    const u = (t.user_input ?? "").trim();
    const a = (t.output ?? "").trim();
    if (!u && !a) continue;
    parts.push(`User:\n${u || "(empty)"}\n\nAssistant:\n${a || "(empty)"}`);
  }
  return parts.join("\n\n---\n\n");
}

/** System-prompt block injected when a conversation is compacted. */
export function buildCompactSystemBlock(summary: string): string {
  const s = summary.trim();
  if (!s) return "";
  return (
    "[Compacted earlier conversation]\n" +
    "The following is a summary of earlier turns in this thread. Treat it as " +
    "authoritative context. Recent turns (if any) follow as normal messages.\n\n" +
    s +
    "\n\n[End compacted context]"
  );
}

/**
 * Apply compact state to a full ordered turn list.
 * - priorTurns: only turns AFTER through_turn_index (raw recent context)
 * - compactBlock: summary system block when state is present
 * - turnIndex: max(turn_index)+1 or 0
 */
export function applyCompactToPriorTurns(
  allTurns: ChatTurnRow[],
  state: ConversationCompactState | null,
): PriorContext {
  const usable = allTurns.filter((t) => t.user_input && t.output);
  // Next index must clear every stored turn_index, including empty/failed rows
  // that were filtered out of the wire history.
  const turnIndex = allTurns.length
    ? Math.max(...allTurns.map((t) => t.turn_index)) + 1
    : 0;

  if (!state?.summary?.trim()) {
    return {
      priorTurns: usable.map((t) => ({ user_input: t.user_input, output: t.output })),
      turnIndex,
      compactBlock: null,
      compact: null,
    };
  }

  const through = state.through_turn_index;
  const recent = usable.filter((t) => t.turn_index > through);
  const block = buildCompactSystemBlock(state.summary);
  return {
    priorTurns: recent.map((t) => ({ user_input: t.user_input, output: t.output })),
    turnIndex,
    compactBlock: block || null,
    compact: state,
  };
}

/** Clamp and normalize a model-produced summary for storage / injection. */
export function normalizeSummary(raw: string): string {
  let s = (raw ?? "").trim();
  if (s.length > COMPACT_SUMMARY_MAX_CHARS) {
    s = s.slice(0, COMPACT_SUMMARY_MAX_CHARS) + "\n[summary truncated]";
  }
  return s;
}

export const COMPACT_SYSTEM_PROMPT =
  "You compress multi-turn chat history into a continuity brief for another " +
  "assistant that will continue the conversation. Preserve: decisions, facts, " +
  "names, constraints, open questions, and anything the user asked to remember. " +
  "Drop chit-chat and repeated boilerplate. Write in neutral third person or " +
  "tight bullet form. No preamble like 'Here is a summary'.";
