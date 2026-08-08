-- 0004: CSP violation collector (fleet-chezmoi#1646).
--
-- Two tables, and the split is the point. `csp_report_buckets` is a rate-limit
-- counter and could have reused `auth_attempts`, which already has exactly this
-- shape and a prefixed bucket-key namespace. It deliberately does not.
--
-- WHY: the collector's write endpoint is UNAUTHENTICATED by construction, because
-- browsers post CSP reports without credentials. Pointing an unauthenticated
-- public write path at the same table the LOGIN limiter depends on means a flood
-- against the collector contends with sign-in. One extra table is a cheap price
-- for not coupling a public write path to the auth path.
--
-- Apply to an existing database with:
--   npx wrangler d1 execute skyphusion-llm --remote --file=migrations/0004_csp_reports.sql
-- Fresh databases get this from schema.sql.

-- Collected violations. Every column is a BOUNDED projection of an
-- attacker-controlled report body; nothing is stored verbatim.
--
-- NOT STORED, deliberately: `script-sample`. It can carry fragments of inline
-- script from a page that handles a credential, and a violation is diagnosable
-- from the directive plus the blocked URI without it.
CREATE TABLE IF NOT EXISTS csp_reports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at         TEXT NOT NULL DEFAULT (datetime('now')),
  -- document_uri is stored with query and fragment STRIPPED. The SPA puts
  -- nothing in URLs (measured), so this costs nothing today and stops the
  -- collector becoming the first place a URL-borne value is persisted.
  document_uri        TEXT,
  referrer            TEXT,
  violated_directive  TEXT,
  effective_directive TEXT,
  blocked_uri         TEXT,
  disposition         TEXT,
  status_code         INTEGER,
  source_file         TEXT,
  line_number         INTEGER,
  column_number       INTEGER
);

-- Read path is operator-only and deliberately has no HTTP endpoint: there is no
-- admin role on this product, so an authenticated read route would let any
-- signed-up user read operator diagnostics from a credential-handling page.
-- Operators query with:
--   npx wrangler d1 execute skyphusion-llm --remote \
--     --command "SELECT received_at, effective_directive, blocked_uri, document_uri
--                FROM csp_reports ORDER BY id DESC LIMIT 50;"
CREATE INDEX IF NOT EXISTS idx_csp_reports_received ON csp_reports(received_at);

-- Rate-limit buckets for the collector, isolated from auth_attempts per the note
-- above. `dropped` is what makes shedding VISIBLE: without it a rate-limited
-- estate and a quiet one produce an identical empty table.
CREATE TABLE IF NOT EXISTS csp_report_buckets (
  bucket_key   TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  dropped      INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT (datetime('now'))
);
