// Workers-runtime integration tests for the fetch handler (v0.164.4, issue #84).
//
// These run inside workerd (see vitest.workers.config.ts) and exercise
// src/index.ts end to end via the SELF service binding, with real local
// Miniflare D1 + R2. They cover the paths that had zero unit coverage and were
// verified only by live wrangler dev smoke: routing + 404 fallthrough,
// getUserEmail, per-user D1 scoping, the R2 ownership gate, /api/prefs, and the
// gateway 412 refusal path. #80 (auth-plane rewrite) can modify getUserEmail
// and watch these fail before shipping.

import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MODELS } from "../src/models";
import { VERSION } from "../src/version";
import schemaSql from "../schema.sql?raw";

const ALICE = "alice@example.com";
const BOB = "bob@example.com";

// Apply schema.sql (the fresh-database DDL) statement by statement. The two
// ALTER TABLE ADD COLUMN statements are not idempotent in SQLite, so a re-apply
// on an already-migrated DB throws "duplicate column name"; that (and "already
// exists") is tolerated so this is safe to call before every test regardless of
// the pool storage-isolation model. Any other error is a real failure and
// rethrown.
async function applySchema(db: D1Database): Promise<void> {
  const statements = schemaSql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    try {
      await db.prepare(stmt).run();
    } catch (e) {
      const msg = String((e as { message?: string })?.message ?? e);
      if (/duplicate column name|already exists/i.test(msg)) continue;
      throw e;
    }
  }
}

const USER_TABLES = [
  "chats",
  "user_prefs",
  "documents",
  "chunks",
  "projects",
  "project_documents",
  "project_messages",
];

beforeEach(async () => {
  await applySchema(env.DB);
  // Guarantee a clean data slate per test whether or not storage is isolated.
  for (const t of USER_TABLES) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

interface ReqOpts {
  email?: string;
  method?: string;
  body?: unknown;
}

// Fire a request at the worker through SELF. Sets the Cloudflare Access header
// only when an email is provided so the anonymous fallback is exercisable.
function req(path: string, opts: ReqOpts = {}): Promise<Response> {
  const headers = new Headers();
  if (opts.email) headers.set("cf-access-authenticated-user-email", opts.email);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`https://prism.test${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function seedChat(
  email: string,
  opts: {
    model?: string;
    model_type?: string;
    user_input?: string;
    output?: string;
    conversation_id?: string | null;
    turn_index?: number;
    output_artifact?: string | null;
  } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO chats
       (user_email, model, model_type, user_input, output, conversation_id, turn_index, status, output_artifact)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'done', ?)`,
  )
    .bind(
      email,
      opts.model ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      opts.model_type ?? "chat",
      opts.user_input ?? "hello",
      opts.output ?? "hi there",
      opts.conversation_id ?? null,
      opts.turn_index ?? 0,
      opts.output_artifact ?? null,
    )
    .run();
}

// A Workers AI chat model (no explicit provider) needs no CF_AIG token, so the
// gateway 412 gate is the ONLY thing standing between a request and dispatch.
const WORKERS_AI_CHAT = MODELS.find((m) => m.type === "chat" && !m.provider)!.id;

describe("routing + 404 fallthrough", () => {
  it("GET /health returns 200 without any binding access", async () => {
    const res = await req("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("GET /health puts the serving version on the wire, unauthenticated", async () => {
    // The deploy-verification surface (fleet-chezmoi#1641). This asserts the WIRE, which is a
    // different failure mode from "the literal drifted from package.json" -- that one is owned by
    // tests/version.test.ts, which reads package.json off disk. Breaking the literal reddens that
    // file and leaves this one green; dropping this field reddens this one and leaves that file
    // green, which is what makes them two assertions rather than one check wearing two names.
    //
    // Compared against VERSION rather than a typed literal, so this test cannot itself become a
    // second copy of the version string to forget at release time.
    const res = await req("/health");
    const body = (await res.json()) as { version?: string };
    expect(body.version).toBe(VERSION);
  });

  it("GET /health/deep carries the version alongside its checks", async () => {
    // Readiness answers 503 for reasons unrelated to which build is running, so the build
    // identifier has to be present on this payload whatever the status code says.
    const res = await req("/health/deep");
    const body = (await res.json()) as { version?: string; checks?: unknown };
    expect(body.version).toBe(VERSION);
    expect(body.checks).toBeDefined();
  });

  it("GET /api/models matches the models route", async () => {
    const res = await req("/api/models", { email: ALICE });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: unknown[]; user: string };
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models.length).toBeGreaterThan(0);
  });

  it("an unmatched path falls through to ASSETS", async () => {
    const res = await req("/no/such/route", { email: ALICE });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("assets-fallthrough");
  });

  it("a matched path with the wrong method falls through to ASSETS", async () => {
    // /api/history is GET-only; POST must NOT be handled by the history route.
    const res = await req("/api/history", { email: ALICE, method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("assets-fallthrough");
  });
});

describe("getUserEmail header / anonymous fallback (src/index.ts:204)", () => {
  beforeEach(() => {
    (env as unknown as { ACCESS_ALLOW_ANONYMOUS?: string }).ACCESS_ALLOW_ANONYMOUS = "1";
  });

  it("falls back to anonymous when the Access header is absent", async () => {
    const res = await req("/api/models");
    const body = (await res.json()) as { user: string };
    expect(body.user).toBe("anonymous");
  });

  it("echoes the Access header email when present", async () => {
    const res = await req("/api/models", { email: ALICE });
    const body = (await res.json()) as { user: string };
    expect(body.user).toBe(ALICE);
  });
});

describe("per-user scoping: /api/history", () => {
  it("returns only the callers rows", async () => {
    await seedChat(ALICE, { user_input: "alice-one" });
    await seedChat(ALICE, { user_input: "alice-two" });
    await seedChat(BOB, { user_input: "bob-one" });

    const aliceRes = await req("/api/history", { email: ALICE });
    const alice = (await aliceRes.json()) as { user: string; chats: Array<{ user_input: string }> };
    expect(alice.user).toBe(ALICE);
    expect(alice.chats).toHaveLength(2);
    expect(alice.chats.map((c) => c.user_input).sort()).toEqual(["alice-one", "alice-two"]);

    const bobRes = await req("/api/history", { email: BOB });
    const bob = (await bobRes.json()) as { chats: Array<{ user_input: string }> };
    expect(bob.chats).toHaveLength(1);
    expect(bob.chats[0].user_input).toBe("bob-one");
  });

  it("anonymous sees none of a named users rows", async () => {
    await seedChat(ALICE, { user_input: "alice-secret" });
    const res = await req("/api/history");
    const body = (await res.json()) as { user: string; chats: unknown[] };
    expect(body.user).toBe("anonymous");
    expect(body.chats).toHaveLength(0);
  });
});

describe("per-user scoping: /api/conversations", () => {
  it("groups only the callers conversations", async () => {
    await seedChat(ALICE, { conversation_id: "conv-a", turn_index: 0, user_input: "a-0" });
    await seedChat(ALICE, { conversation_id: "conv-a", turn_index: 1, user_input: "a-1" });
    await seedChat(ALICE, { conversation_id: "conv-b", turn_index: 0, user_input: "b-0" });
    await seedChat(BOB, { conversation_id: "conv-c", turn_index: 0, user_input: "c-0" });

    const aliceRes = await req("/api/conversations", { email: ALICE });
    const alice = (await aliceRes.json()) as {
      conversations: Array<{ conversation_id: string; turn_count: number }>;
    };
    const ids = alice.conversations.map((c) => c.conversation_id).sort();
    expect(ids).toEqual(["conv-a", "conv-b"]);
    const convA = alice.conversations.find((c) => c.conversation_id === "conv-a")!;
    expect(convA.turn_count).toBe(2);

    const bobRes = await req("/api/conversations", { email: BOB });
    const bob = (await bobRes.json()) as { conversations: Array<{ conversation_id: string }> };
    expect(bob.conversations.map((c) => c.conversation_id)).toEqual(["conv-c"]);
  });
});

describe("R2 ownership gate: /api/artifact/*", () => {
  const KEY = "out/owned.png";
  const BYTES = new Uint8Array([1, 2, 3, 4]);

  beforeEach(async () => {
    await env.R2.put(KEY, BYTES, { customMetadata: { user_email: ALICE } });
  });

  it("serves the object to its owner", async () => {
    const res = await req(`/api/artifact/${KEY}`, { email: ALICE });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
  });

  it("rejects a foreign user with 403 (customMetadata.user_email mismatch)", async () => {
    const res = await req(`/api/artifact/${KEY}`, { email: BOB });
    expect(res.status).toBe(403);
  });

  it("rejects anonymous with 403", async () => {
    const res = await req(`/api/artifact/${KEY}`);
    expect(res.status).toBe(403);
  });

  it("returns 404 for a missing object", async () => {
    const res = await req("/api/artifact/out/does-not-exist.png", { email: ALICE });
    expect(res.status).toBe(404);
  });
});

describe("/api/prefs GET/PATCH round-trip", () => {
  it("GET reports unconfigured for a fresh user", async () => {
    const res = await req("/api/prefs", { email: ALICE });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      gateway_id: string | null;
      cf_aig_token_set: boolean;
      configured: boolean;
    };
    expect(body.gateway_id).toBeNull();
    expect(body.cf_aig_token_set).toBe(false);
    expect(body.configured).toBe(false);
  });

  it("PATCH persists per user and never echoes the raw token", async () => {
    const RAW_TOKEN = "cf-aig-supersecret-token-1234567890";
    const patchRes = await req("/api/prefs", {
      email: ALICE,
      method: "PATCH",
      body: { gateway_id: "alice-gw", cf_aig_token: RAW_TOKEN },
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as {
      gateway_id: string | null;
      cf_aig_token_set: boolean;
      cf_aig_token_preview: string | null;
      configured: boolean;
    };
    expect(patched.gateway_id).toBe("alice-gw");
    expect(patched.cf_aig_token_set).toBe(true);
    expect(patched.configured).toBe(true);
    // Secret hygiene: the response carries a mask, never the raw token.
    expect(patched.cf_aig_token_preview).not.toBe(RAW_TOKEN);
    expect(patched.cf_aig_token_preview).not.toContain(RAW_TOKEN.slice(0, 8));

    // Round-trip: a fresh GET reads the persisted prefs back.
    const getRes = await req("/api/prefs", { email: ALICE });
    const got = (await getRes.json()) as { gateway_id: string | null; configured: boolean };
    expect(got.gateway_id).toBe("alice-gw");
    expect(got.configured).toBe(true);

    // Isolation: bobs prefs are untouched.
    const bobRes = await req("/api/prefs", { email: BOB });
    const bob = (await bobRes.json()) as { gateway_id: string | null; configured: boolean };
    expect(bob.gateway_id).toBeNull();
    expect(bob.configured).toBe(false);
  });
});

describe("gateway 412 refusal path", () => {
  it("POST /api/chat returns 412 when no gateway id resolves", async () => {
    const res = await req("/api/chat", {
      email: ALICE,
      method: "POST",
      body: { model: WORKERS_AI_CHAT, user_input: "hi" },
    });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: string; code?: string };
    // Copy mentions both BYOK gateway and control-plane pcp_ (v0.175.3).
    expect(body.code).toBe("gateway_not_configured");
    expect(body.error).toContain("Inference not configured");
    expect(body.error).toMatch(/pcp_/);
  });

  it("positive control: once a gateway id is set, the 412 gate no longer fires", async () => {
    await req("/api/prefs", {
      email: ALICE,
      method: "PATCH",
      body: { gateway_id: "alice-gw" },
    });
    // Past the gate the stubbed AI binding makes dispatch fail (500), which is
    // fine: the point is only that the 412 refusal is no longer returned, so
    // the gate is proven non-vacuous rather than always-on.
    let status: number;
    try {
      status = (
        await req("/api/chat", {
          email: ALICE,
          method: "POST",
          body: { model: WORKERS_AI_CHAT, user_input: "hi" },
        })
      ).status;
    } catch {
      status = 500;
    }
    expect(status).not.toBe(412);
  });
});

// ---------------------------------------------------------------------------
// Inference gate coverage across transports (skyphusion-labs/fleet-chezmoi#1611)
//
// The 412 suite above proves the gate fires for one chat model. These assert it
// holds for every model in the catalog that reaches an image inference path,
// including the @cf models whose request/response shapes force the call to
// bypass the AI Gateway transport.
//
// The population is DERIVED from MODELS rather than enumerated here. A hand
// list would have to be extended by whoever adds the next model, which is
// exactly the maintenance step that does not happen; deriving it means a model
// landing later with some new transport is covered on the day it lands.
// ---------------------------------------------------------------------------

const IMAGE_MODELS = MODELS.filter((m) => m.type === "image");
const CF_IMAGE_MODELS = IMAGE_MODELS.filter((m) => !m.provider);
const PROXIED_IMAGE_MODELS = IMAGE_MODELS.filter((m) => !!m.provider);

describe("inference gate: image models, every transport", () => {
  it("harness control: the catalog yields both image transport classes", () => {
    // If either filter stops matching the catalog these counts go to zero and
    // the per-model assertions below vanish silently, passing vacuously. This
    // asserts the population exists so an empty run reads as a harness failure
    // rather than as a clean result.
    expect(IMAGE_MODELS.length).toBeGreaterThan(0);
    expect(CF_IMAGE_MODELS.length).toBeGreaterThan(0);
    expect(PROXIED_IMAGE_MODELS.length).toBeGreaterThan(0);
  });

  for (const model of IMAGE_MODELS) {
    it(`refuses ${model.id} with 412 when no gateway id resolves`, async () => {
      const res = await req("/api/chat", {
        email: ALICE,
        method: "POST",
        body: { model: model.id, user_input: "a cat" },
      });
      expect(res.status).toBe(412);
      const body = (await res.json()) as { code?: string };
      // Assert WHICH refusal fired. A bare "the request failed" is satisfied
      // by the stubbed AI binding throwing on dispatch, which is the opposite
      // of the gate doing its job: it would mean the request got past the gate
      // and only failed because this harness has no real binding.
      expect(body.code).toBe("gateway_not_configured");
    });
  }

  it("positive control: a @cf image model dispatches once a gateway id is set", async () => {
    // Proves the 412s above are a real refusal and not an always-on wall. Past
    // the gate the inert AI stub makes dispatch fail; the only claim here is
    // that the failure is no longer the gate.
    const model = CF_IMAGE_MODELS[0]!;
    await req("/api/prefs", {
      email: ALICE,
      method: "PATCH",
      body: { gateway_id: "alice-gw" },
    });
    let status: number;
    try {
      status = (
        await req("/api/chat", {
          email: ALICE,
          method: "POST",
          body: { model: model.id, user_input: "a cat" },
        })
      ).status;
    } catch {
      status = 500;
    }
    expect(status).not.toBe(412);
  });

  it("proxied image models still require a CF token, and say so distinctly", async () => {
    // The two refusals must stay distinguishable: a gateway id alone satisfies
    // a @cf model (control above) but not a proxied one. If these ever collapse
    // into one code, the control above stops proving anything about @cf models.
    const model = PROXIED_IMAGE_MODELS[0]!;
    await req("/api/prefs", {
      email: BOB,
      method: "PATCH",
      body: { gateway_id: "bob-gw" },
    });
    const res = await req("/api/chat", {
      email: BOB,
      method: "POST",
      body: { model: model.id, user_input: "a cat" },
    });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("cf_aig_token_required");
  });
});

describe("inference gate: live-voice WebSocket upgrade", () => {
  // This path runs inside the SttSession Durable Object rather than in a route
  // handler, and opens its upstream through the same AI binding. It is the one
  // inference entry point that is not an /api/chat dispatch, which is exactly
  // why it needs its own assertion rather than being assumed covered.
  function upgrade(email?: string): Promise<Response> {
    const headers = new Headers({ Upgrade: "websocket" });
    if (email) headers.set("cf-access-authenticated-user-email", email);
    return SELF.fetch("https://prism.test/api/stt/stream", { headers });
  }

  it("refuses the upgrade with 412 when no gateway id resolves", async () => {
    const res = await upgrade(ALICE);
    expect(res.status).toBe(412);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("gateway_not_configured");
  });

  it("positive control: past the gate the upgrade reaches the upstream open", async () => {
    // Proves the 412 above is the credential gate and not simply "this path
    // never works in a test". With a gateway id set the DO gets as far as
    // opening the upstream flux socket, which fails against the inert AI stub
    // and surfaces as 502 -- a different failure, at a later stage.
    await req("/api/prefs", {
      email: ALICE,
      method: "PATCH",
      body: { gateway_id: "alice-gw" },
    });
    let status: number;
    try {
      status = (await upgrade(ALICE)).status;
    } catch {
      status = 500;
    }
    expect(status).not.toBe(412);
  });
});
