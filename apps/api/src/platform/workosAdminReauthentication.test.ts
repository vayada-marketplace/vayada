import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminTransferBinding } from "@vayada/backend-auth";
import { createWorkOSAdminReauthentication } from "./workosAdminReauthentication.js";
const mocks = vi.hoisted(() => ({ exchange: vi.fn() }));
vi.mock("@workos-inc/node", async (original) => {
  const sdk = await original<typeof import("@workos-inc/node")>();
  return {
    ...sdk,
    WorkOS: class extends sdk.WorkOS {
      constructor(...args: ConstructorParameters<typeof sdk.WorkOS>) {
        super(...args);
        this.userManagement.authenticateWithCode = mocks.exchange;
      }
    },
  };
});
const binding: AdminTransferBinding = {
  organizationId: "org_internal",
  actorMembershipId: "actor",
  targetMembershipId: "target",
  workosUserId: "user_workos",
  workosOrgId: "org_workos",
  sessionId: "source_session",
  requestDigest: "a".repeat(64),
};
const state = "s".repeat(43);
const callbackUrl = "https://api.example.com/identity/staff/admin-transfer/callback";
const verifyProof = vi.fn();
const config = {
  apiKey: "sk_test",
  clientId: "client_test",
  callbackUrl,
  cookieSecret: "secret".repeat(8),
  verifyProof,
};
const input = (flowCookie: string) => ({
  flowCookie,
  state,
  code: "provider_code",
  source: binding,
});
beforeEach(() => {
  mocks.exchange.mockReset().mockResolvedValue({ accessToken: "provider_token" });
  verifyProof.mockReset().mockResolvedValue("proof_id");
});
afterEach(() => {
  vi.useRealTimers();
});
describe("WorkOS admin reauthentication", () => {
  it("forces hosted reauthentication and exchanges the matching PKCE verifier without exposing tokens", async () => {
    const adapter = createWorkOSAdminReauthentication(config);
    const flow = await adapter.start(binding, state, "admin@example.com");
    const url = new URL(flow.authorizationUrl);
    for (const [key, value] of Object.entries({
      provider: "authkit",
      max_age: "0",
      organization_id: binding.workosOrgId,
      redirect_uri: callbackUrl,
      state,
      code_challenge_method: "S256",
    }))
      expect(url.searchParams.get(key)).toBe(value);
    expect(flow.authorizationUrl).not.toContain(binding.requestDigest);
    expect(flow.flowCookie).not.toContain(binding.sessionId);
    expect(await adapter.complete(input(flow.flowCookie))).toEqual({
      proofId: "proof_id",
      binding,
    });
    const exchanged = mocks.exchange.mock.calls[0]![0];
    expect(createHash("sha256").update(exchanged.codeVerifier).digest("base64url")).toBe(
      url.searchParams.get("code_challenge"),
    );
    expect(exchanged).toMatchObject({ code: "provider_code", clientId: "client_test" });
    expect(exchanged.session).toBeUndefined();
    expect(verifyProof).toHaveBeenCalledWith(binding, state, "provider_token");
  });
  it("rejects changed source bindings before exchanging the code", async () => {
    const adapter = createWorkOSAdminReauthentication(config);
    const flow = await adapter.start(binding, state, "admin@example.com");
    for (const key of [
      "organizationId",
      "actorMembershipId",
      "workosUserId",
      "workosOrgId",
      "sessionId",
    ]) {
      expect(
        await adapter.complete({
          ...input(flow.flowCookie),
          source: { ...binding, [key]: "other" },
        }),
      ).toBeNull();
    }
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it("rejects missing, tampered, expired or wrong-callback cookies and mismatched state", async () => {
    const adapter = createWorkOSAdminReauthentication(config);
    const flow = await adapter.start(binding, state, "admin@example.com");
    for (const patch of [
      { flowCookie: "" },
      { flowCookie: flow.flowCookie.slice(0, -12) + "x".repeat(12) },
      { state: "different" },
      { code: "" },
    ]) {
      expect(await adapter.complete({ ...input(flow.flowCookie), ...patch })).toBeNull();
    }
    expect(
      await createWorkOSAdminReauthentication({
        ...config,
        callbackUrl: "https://other.example/callback",
      }).complete(input(flow.flowCookie)),
    ).toBeNull();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 301_000);
    expect(await adapter.complete(input(flow.flowCookie))).toBeNull();
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it("fails closed on provider errors, impersonation and rejected proofs", async () => {
    const adapter = createWorkOSAdminReauthentication(config);
    const flow = await adapter.start(binding, state, "admin@example.com");
    mocks.exchange.mockRejectedValueOnce(new Error("sensitive provider details"));
    expect(await adapter.complete(input(flow.flowCookie))).toBeNull();
    mocks.exchange.mockResolvedValueOnce({
      accessToken: "token",
      impersonator: { email: "support@example.com" },
    });
    expect(await adapter.complete(input(flow.flowCookie))).toBeNull();
    expect(verifyProof).not.toHaveBeenCalled();
    verifyProof.mockResolvedValueOnce(null);
    expect(await adapter.complete(input(flow.flowCookie))).toBeNull();
    verifyProof.mockRejectedValueOnce(new Error("repository unavailable"));
    expect(await adapter.complete(input(flow.flowCookie))).toBeNull();
  });
});
