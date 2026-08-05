import { describe, expect, it } from "vitest";
import {
  buildGatewayStatus,
  gatewaySource,
  maskSecret,
  resolveGatewayFromParts,
} from "../src/gateway-credentials";
import type { Env } from "../src/env";

function env(partial: Partial<Env> = {}): Env {
  return partial as Env;
}

const VALID_PCP = `pcp_${"a".repeat(16)}_${"A".repeat(43)}`;

describe("resolveGatewayFromParts", () => {
  it("returns null when no gateway id is available", () => {
    expect(resolveGatewayFromParts(null, env())).toBeNull();
    expect(resolveGatewayFromParts({ gateway_id: "  " }, env())).toBeNull();
  });

  it("merges user prefs over worker secrets field-by-field", () => {
    const resolved = resolveGatewayFromParts(
      { gateway_id: "user-gw", cf_aig_token: "user-token" },
      env({ GATEWAY_ID: "worker-gw", CF_AIG_TOKEN: "worker-token" }),
    );
    expect(resolved).toEqual({ gatewayId: "user-gw", cfAigToken: "user-token" });
  });

  it("falls back to worker secrets for unset user fields", () => {
    const resolved = resolveGatewayFromParts(
      { gateway_id: "user-gw" },
      env({ GATEWAY_ID: "worker-gw", CF_AIG_TOKEN: "worker-token" }),
    );
    expect(resolved).toEqual({ gatewayId: "user-gw", cfAigToken: "worker-token" });
  });
});

describe("gatewaySource", () => {
  it("labels pure user credentials", () => {
    expect(gatewaySource(
      { gateway_id: "gw", cf_aig_token: "tok" },
      env(),
    )).toBe("user");
  });

  it("labels worker-only credentials", () => {
    expect(gatewaySource(null, env({ GATEWAY_ID: "gw" }))).toBe("worker");
  });

  it("labels mixed overrides", () => {
    expect(gatewaySource(
      { gateway_id: "user-gw" },
      env({ GATEWAY_ID: "worker-gw", CF_AIG_TOKEN: "worker-token" }),
    )).toBe("mixed");
  });
});

describe("maskSecret", () => {
  it("masks long secrets with trailing preview", () => {
    expect(maskSecret("abcdefghijklmnop")).toBe("••••••••••••mnop");
  });

  it("returns null for empty values", () => {
    expect(maskSecret(undefined)).toBeNull();
    expect(maskSecret("   ")).toBeNull();
  });
});

describe("buildGatewayStatus", () => {
  it("is unconfigured with no gateway and no pcp_ key", () => {
    const s = buildGatewayStatus(null, env());
    expect(s.configured).toBe(false);
    expect(s.control_plane_configured).toBe(false);
    expect(s.control_plane_key_set).toBe(false);
  });

  it("counts gateway id alone as configured (BYOK path)", () => {
    const s = buildGatewayStatus({ gateway_id: "my-gw" }, env());
    expect(s.configured).toBe(true);
    expect(s.gateway_id).toBe("my-gw");
    expect(s.control_plane_configured).toBe(false);
  });

  it("counts a pcp_ key alone as configured (no gateway slug)", () => {
    // Hard-refresh boot probe used to miss this: loadGatewayStatus only looked
    // at gateway id, so the SPA banner said "configure instance" while prefs
    // still showed control-plane mode on.
    const s = buildGatewayStatus({ control_plane_key: VALID_PCP }, env());
    expect(s.configured).toBe(true);
    expect(s.control_plane_configured).toBe(true);
    expect(s.control_plane_key_set).toBe(true);
    expect(s.gateway_id).toBeNull();
  });

  it("rejects a malformed pcp_ key", () => {
    const s = buildGatewayStatus({ control_plane_key: "pcp_not_valid" }, env());
    expect(s.configured).toBe(false);
    expect(s.control_plane_configured).toBe(false);
    expect(s.control_plane_key_set).toBe(true);
  });
});
