-- Conversation compact state (v0.175.7 / prism compact ability).
--
-- Multi-turn chat currently resends every prior turn text into the model
-- context. A long thread blows the window. Compact stores a model-written
-- summary of older turns; the next chat turn injects that summary and only
-- the recent raw turns. The full transcript in chats stays intact for the UI.
--
-- through_turn_index is inclusive: turns with turn_index <= through_turn_index
-- are covered by summary and are NOT re-sent as raw user/assistant pairs.
-- keep_recent is recorded for display; the authoritative cut is through_turn_index.

CREATE TABLE IF NOT EXISTS conversation_compact (
  conversation_id     TEXT NOT NULL,
  user_email          TEXT NOT NULL,
  summary             TEXT NOT NULL,
  through_turn_index  INTEGER NOT NULL,
  keep_recent         INTEGER NOT NULL DEFAULT 2,
  model               TEXT NOT NULL,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (conversation_id, user_email)
);

CREATE INDEX IF NOT EXISTS idx_conversation_compact_user
  ON conversation_compact(user_email);
