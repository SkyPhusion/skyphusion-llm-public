// Conversation routes: list conversations (grouped by conversation_id), fetch a
// full transcript, delete a conversation (cascading R2 artifacts across all its
// turns), move a conversation to/from a project, and compact (summarize older
// turns for model context). Scoped to the caller.

import type { Env } from "../env";
import { MODELS } from "../models";
import type { ModelEntry } from "../models";
import { aiRun, aiLogId, type AiContext } from "../ai-binding";
import { extractOutput, detectProviderFailure } from "../output-extract";
import { callAnthropic } from "../providers/anthropic";
import { callXai } from "../providers/xai";
import { callGemini } from "../providers/google";
import { callOpenAI } from "../providers/openai";
import {
  json,
  getUserEmail,
  r2DeleteSafe,
  safeParseJson,
  requireInferenceBackend,
  modelNeedsCfAigToken,
} from "./shared";
import type { PersistedAttachment, OutputArtifact, RetrievedItem } from "./shared";
import { controlPlaneChat } from "../control-plane";
import {
  DEFAULT_KEEP_RECENT,
  COMPACT_SYSTEM_PROMPT,
  type ChatTurnRow,
  type ConversationCompactState,
  splitTurnsForCompact,
  formatTurnsForSummary,
  normalizeSummary,
} from "../conversation-context";

/** Default cheap Workers AI chat model for compact when the client omits model. */
export const DEFAULT_COMPACT_MODEL = "@cf/meta/llama-3.2-3b-instruct";

export async function loadCompactState(
  env: Env,
  conversationId: string,
  userEmail: string,
): Promise<ConversationCompactState | null> {
  const row = await env.DB.prepare(
    `SELECT summary, through_turn_index, keep_recent, model, updated_at
       FROM conversation_compact
      WHERE conversation_id = ? AND user_email = ?`,
  )
    .bind(conversationId, userEmail)
    .first<{
      summary: string;
      through_turn_index: number;
      keep_recent: number;
      model: string;
      updated_at: string;
    }>();
  if (!row?.summary) return null;
  return {
    summary: row.summary,
    through_turn_index: row.through_turn_index,
    keep_recent: row.keep_recent,
    model: row.model,
    updated_at: row.updated_at,
  };
}

export async function loadChatTurns(
  env: Env,
  conversationId: string,
  userEmail: string,
): Promise<ChatTurnRow[]> {
  const r = await env.DB.prepare(
    `SELECT user_input, output, turn_index
       FROM chats
      WHERE conversation_id = ?
        AND user_email = ?
        AND status = 'done'
        AND model_type = 'chat'
      ORDER BY turn_index ASC`,
  )
    .bind(conversationId, userEmail)
    .all<ChatTurnRow>();
  return r.results ?? [];
}

// ---------- Multi-turn conversations ----------
//
// A conversation is a set of chat rows sharing the same conversation_id,
// ordered by turn_index. Old single-turn chats with NULL conversation_id
// were backfilled in the migration to 'legacy-<id>' so they still appear
// in the list. Non-chat rows (image/tts/etc) get 'single-<id>' assigned
// at persistChat time and show as single-turn entries.
//
// handleConversationList returns one row per distinct conversation_id with
// a summary: turn count, first prompt, latest model, last activity. Used
// by the sidebar as the replacement for the per-row history list.
//
// handleConversationGet returns all rows of a conversation in turn order.
// Used when the user clicks a conversation to view the full transcript.

export async function handleConversationList(request: Request, env: Env): Promise<Response> {
  const userEmail = await getUserEmail(request, env);

  // Group by conversation_id. For each, give:
  //   - turn_count, first/last timestamps
  //   - the first user_input as a preview
  //   - the model used in the latest turn
  //   - whether any turn has a non-null output_artifact (for the icon)
  //   - the model_type of the first turn (chat/image/tts/video/music/stt)
  //   - v0.20.2: project_id from the conversation's first turn (the sidebar
  //     shows a project chip when this is set). project_id is a per-row
  //     column but conversations are expected to have a uniform value
  //     across turns (handleConversationMoveToProject updates all turns
  //     atomically). Subqueries match the existing pattern for first_input.
  const rows = await env.DB.prepare(
    `SELECT
        c.conversation_id,
        COUNT(*) AS turn_count,
        MIN(c.created_at) AS first_created_at,
        MAX(c.created_at) AS last_created_at,
        (SELECT user_input FROM chats c2
          WHERE c2.conversation_id = c.conversation_id AND c2.user_email = c.user_email
          ORDER BY c2.turn_index ASC LIMIT 1) AS first_input,
        (SELECT model FROM chats c2
          WHERE c2.conversation_id = c.conversation_id AND c2.user_email = c.user_email
          ORDER BY c2.turn_index DESC LIMIT 1) AS latest_model,
        (SELECT model_type FROM chats c2
          WHERE c2.conversation_id = c.conversation_id AND c2.user_email = c.user_email
          ORDER BY c2.turn_index ASC LIMIT 1) AS first_model_type,
        (SELECT project_id FROM chats c2
          WHERE c2.conversation_id = c.conversation_id AND c2.user_email = c.user_email
          ORDER BY c2.turn_index ASC LIMIT 1) AS project_id,
        SUM(CASE WHEN output_artifact IS NOT NULL THEN 1 ELSE 0 END) AS artifact_count
      FROM chats c
      WHERE c.user_email = ?
      GROUP BY c.conversation_id
      ORDER BY last_created_at DESC
      LIMIT 200`
  )
    .bind(userEmail)
    .all<{
      conversation_id: string;
      turn_count: number;
      first_created_at: string;
      last_created_at: string;
      first_input: string;
      latest_model: string;
      first_model_type: string;
      project_id: number | null;
      artifact_count: number;
    }>();
  return json({ user: userEmail, conversations: rows.results ?? [] });
}

export async function handleConversationGet(request: Request, env: Env, id: string): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const rows = await env.DB.prepare(
    `SELECT * FROM chats
      WHERE conversation_id = ? AND user_email = ?
      ORDER BY turn_index ASC, created_at ASC`
  )
    .bind(id, userEmail)
    .all<{
      attachments: string | null;
      output_artifact: string | null;
      retrieved_context: string | null;
    }>();

  if ((rows.results ?? []).length === 0) {
    return json({ error: "Not found" }, { status: 404 });
  }

  // Parse the JSON columns on each turn so the frontend doesn't have to.
  const turns = (rows.results ?? []).map((row) => ({
    ...row,
    attachments: row.attachments ? safeParseJson<PersistedAttachment[]>(row.attachments) : null,
    output_artifact: row.output_artifact ? safeParseJson<OutputArtifact>(row.output_artifact) : null,
    retrieved_context: row.retrieved_context ? safeParseJson<RetrievedItem[]>(row.retrieved_context) : null,
  }));

  const compact = await loadCompactState(env, id, userEmail);
  return json({ conversation_id: id, turns, compact });
}

export async function handleConversationDelete(request: Request, env: Env, id: string): Promise<Response> {
  const userEmail = await getUserEmail(request, env);

  // Pull all R2 keys across all turns before deleting D1 rows.
  const rows = await env.DB.prepare(
    `SELECT attachments, output_artifact FROM chats
      WHERE conversation_id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .all<{ attachments: string | null; output_artifact: string | null }>();

  const results = rows.results ?? [];
  if (results.length === 0) {
    return json({ error: "Not found" }, { status: 404 });
  }

  const keysToDelete: string[] = [];
  for (const row of results) {
    if (row.attachments) {
      const atts = safeParseJson<PersistedAttachment[]>(row.attachments) ?? [];
      for (const a of atts) {
        if (a.type === "image") keysToDelete.push(a.key);
        else if (a.type === "video_frames") keysToDelete.push(...(a.keys ?? []));
        else if (a.type === "video_full") keysToDelete.push(a.key);
      }
    }
    if (row.output_artifact) {
      const oa = safeParseJson<OutputArtifact>(row.output_artifact);
      if (oa?.key) keysToDelete.push(oa.key);
    }
  }

  await env.DB.prepare(
    `DELETE FROM chats WHERE conversation_id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .run();

  // Drop compact state with the conversation (no orphan summaries).
  await env.DB.prepare(
    `DELETE FROM conversation_compact WHERE conversation_id = ? AND user_email = ?`,
  )
    .bind(id, userEmail)
    .run();

  for (const k of keysToDelete) {
    await r2DeleteSafe(env, k);
  }

  return json({ deleted: id, turns_removed: results.length, artifacts_removed: keysToDelete.length });
}

// ---------- Compact (v0.175.7) ----------
//
// POST /api/conversations/:id/compact
// Body: { keep_recent?: number, model?: string }
// Summarizes older turns with a chat model; stores the summary so subsequent
// chat turns inject it instead of re-sending those turns. UI transcript is
// unchanged.
//
// DELETE /api/conversations/:id/compact
// Clears compact state; next chat turn resends the full raw history again.

async function summarizeTranscript(
  env: Env,
  userEmail: string,
  model: ModelEntry,
  transcript: string,
): Promise<{ text: string; logId: string | null } | Response> {
  const backendOrErr = await requireInferenceBackend(env, userEmail, {
    requireCfToken: modelNeedsCfAigToken(model),
  });
  if (backendOrErr instanceof Response) return backendOrErr;

  const userContent =
    "Compress the following conversation into a continuity brief.\n\n" + transcript;
  const wantsSystemInMessages = model.provider !== "anthropic" && model.provider !== "google";
  const messages: Array<{ role: string; content: string }> = [];
  if (wantsSystemInMessages) {
    messages.push({ role: "system", content: COMPACT_SYSTEM_PROMPT });
  }
  messages.push({ role: "user", content: userContent });

  try {
    if (backendOrErr.kind === "control_plane") {
      const cpResult = await controlPlaneChat(backendOrErr.cp, {
        model: model.id,
        messages: [
          { role: "system", content: COMPACT_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      });
      return { text: cpResult.text, logId: cpResult.requestId };
    }

    const aiCtx: AiContext = backendOrErr.ctx;
    let result: unknown;
    let logId: string | null = null;
    if (model.provider === "anthropic") {
      const r = await callAnthropic(aiCtx, model, COMPACT_SYSTEM_PROMPT, messages);
      result = r.raw;
      logId = r.logId;
    } else if (model.provider === "xai") {
      const r = await callXai(aiCtx, model, messages);
      result = r.raw;
      logId = r.logId;
    } else if (model.provider === "google") {
      const r = await callGemini(aiCtx, model, COMPACT_SYSTEM_PROMPT, messages);
      result = r.raw;
      logId = r.logId;
    } else if (model.provider === "openai") {
      const r = await callOpenAI(aiCtx, model, messages);
      result = r.raw;
      logId = r.logId;
    } else {
      result = await aiRun(aiCtx, model.id, { messages });
      logId = aiLogId(aiCtx);
    }

    const fail = detectProviderFailure(result);
    if (fail) {
      return json({ error: `Compact model failed: ${fail}` }, { status: 502 });
    }
    const text = extractOutput(result);
    if (!text.trim()) {
      return json({ error: "Compact model returned empty summary" }, { status: 502 });
    }
    return { text, logId };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 402 || status === 403 || status === 429) {
      return json({ error: `Compact AI call failed: ${m}`, code: (err as { code?: string })?.code }, { status });
    }
    return json({ error: `Compact AI call failed: ${m}` }, { status: 502 });
  }
}

export async function handleConversationCompact(
  request: Request,
  env: Env,
  conversationId: string,
): Promise<Response> {
  const userEmail = await getUserEmail(request, env);

  let body: { keep_recent?: number; model?: string } = {};
  try {
    const raw = await request.text();
    if (raw.trim()) body = JSON.parse(raw) as { keep_recent?: number; model?: string };
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const keepRecent =
    typeof body.keep_recent === "number" && Number.isFinite(body.keep_recent)
      ? Math.max(0, Math.min(20, Math.floor(body.keep_recent)))
      : DEFAULT_KEEP_RECENT;

  const modelId = (body.model?.trim() || DEFAULT_COMPACT_MODEL);
  const model = MODELS.find((m) => m.id === modelId);
  if (!model || model.type !== "chat") {
    return json({ error: `Unknown or non-chat model for compact: ${modelId}` }, { status: 400 });
  }

  const turns = await loadChatTurns(env, conversationId, userEmail);
  if (turns.length === 0) {
    return json({ error: "Conversation not found or has no completed chat turns" }, { status: 404 });
  }
  if (turns.length < keepRecent + 1) {
    return json(
      {
        error: `Need at least ${keepRecent + 1} completed chat turns to compact (have ${turns.length})`,
        code: "not_enough_turns",
        turn_count: turns.length,
        keep_recent: keepRecent,
      },
      { status: 400 },
    );
  }

  const { summarize, keep } = splitTurnsForCompact(turns, keepRecent);
  if (summarize.length === 0) {
    return json({ error: "Nothing to summarize with this keep_recent", code: "not_enough_turns" }, { status: 400 });
  }

  const transcript = formatTurnsForSummary(summarize);
  const summarized = await summarizeTranscript(env, userEmail, model, transcript);
  if (summarized instanceof Response) return summarized;

  const summary = normalizeSummary(summarized.text);
  const throughTurnIndex = summarize[summarize.length - 1].turn_index;
  const updatedAt = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO conversation_compact
       (conversation_id, user_email, summary, through_turn_index, keep_recent, model, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id, user_email) DO UPDATE SET
       summary = excluded.summary,
       through_turn_index = excluded.through_turn_index,
       keep_recent = excluded.keep_recent,
       model = excluded.model,
       updated_at = excluded.updated_at`,
  )
    .bind(conversationId, userEmail, summary, throughTurnIndex, keepRecent, model.id, updatedAt)
    .run();

  return json({
    conversation_id: conversationId,
    compact: {
      summary,
      through_turn_index: throughTurnIndex,
      keep_recent: keepRecent,
      model: model.id,
      updated_at: updatedAt,
    },
    turns_summarized: summarize.length,
    turns_kept_raw: keep.length,
    ai_gateway_log_id: summarized.logId,
  });
}

export async function handleConversationCompactClear(
  request: Request,
  env: Env,
  conversationId: string,
): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const existing = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM chats WHERE conversation_id = ? AND user_email = ?`,
  )
    .bind(conversationId, userEmail)
    .first<{ n: number }>();
  if (!existing || existing.n === 0) {
    return json({ error: "Conversation not found" }, { status: 404 });
  }

  const result = await env.DB.prepare(
    `DELETE FROM conversation_compact WHERE conversation_id = ? AND user_email = ?`,
  )
    .bind(conversationId, userEmail)
    .run();

  return json({
    conversation_id: conversationId,
    compact: null,
    cleared: (result.meta?.changes ?? 0) > 0,
  });
}

// v0.20.2: move a conversation to a project (or clear its project assignment).
// Body: { project_id: number | null }. When project_id is a number, the
// project must exist and belong to the same user. When null, the assignment
// is cleared on all turns.
//
// All turns in the conversation are updated atomically. The conversation_id
// is the existing key for ownership (chats.user_email + conversation_id).
export async function handleConversationMoveToProject(
  request: Request,
  env: Env,
  conversationId: string,
): Promise<Response> {
  const userEmail = await getUserEmail(request, env);

  let body: { project_id?: number | null };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const newProjectId = body.project_id ?? null;
  if (newProjectId !== null) {
    if (!Number.isInteger(newProjectId) || newProjectId <= 0) {
      return json({ error: "project_id must be a positive integer or null" }, { status: 400 });
    }
    // Confirm the target project exists and belongs to this user.
    const proj = await env.DB.prepare(
      `SELECT id FROM projects WHERE id = ? AND user_email = ?`
    )
      .bind(newProjectId, userEmail)
      .first();
    if (!proj) return json({ error: "Project not found" }, { status: 404 });
  }

  // Confirm the conversation exists and belongs to this user before
  // updating, otherwise we silently no-op on stale ids.
  const existing = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM chats
      WHERE conversation_id = ? AND user_email = ?`
  )
    .bind(conversationId, userEmail)
    .first<{ n: number }>();
  if (!existing || existing.n === 0) {
    return json({ error: "Conversation not found" }, { status: 404 });
  }

  const result = await env.DB.prepare(
    `UPDATE chats SET project_id = ?
      WHERE conversation_id = ? AND user_email = ?`
  )
    .bind(newProjectId, conversationId, userEmail)
    .run();

  return json({
    conversation_id: conversationId,
    project_id: newProjectId,
    rows_updated: result.meta?.changes ?? 0,
  });
}

