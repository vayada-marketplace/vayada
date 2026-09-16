import { afterEach, describe, expect, it, vi } from "vitest";
import { readLegacyOwnershipTargetRow } from "./channexAdoptionTargetRows.js";
import {
  verifyLegacyCurrentOwnerIdentity,
  type LegacyOwnerIdentityEvidence,
} from "./legacyCurrentOwnerIdentity.js";
vi.mock("./channexAdoptionTargetRows.js", () => ({ readLegacyOwnershipTargetRow: vi.fn() }));
const proof: LegacyOwnerIdentityEvidence = {
  userId: "00000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000002",
  externalIdentityId: "00000000-0000-4000-8000-000000000003",
  externalIdentitySha256: "a".repeat(64),
  workosUserId: "user_synthetic",
  workosOrgId: "org_synthetic",
};
const session = () => ({
  workosUserId: proof.workosUserId,
  workosOrgId: proof.workosOrgId,
  expiresAt: Math.floor(Date.now() / 1000) + 300,
});
function database() {
  const identity = {
    id: proof.externalIdentityId,
    userId: proof.userId,
    providerUserId: proof.workosUserId,
    userStatus: "pending" as string | null,
  };
  const organization = {
    id: proof.organizationId,
    workosOrgId: proof.workosOrgId,
    kind: "hotel_group",
    status: "suspended",
  };
  const identities = [identity];
  const organizations = [organization];
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("external_identities") ? identities : organizations,
  }));
  vi.mocked(readLegacyOwnershipTargetRow).mockResolvedValue({
    id: proof.externalIdentityId,
    rowStateSha256: proof.externalIdentitySha256,
  });
  return { query, identity, organization, identities, organizations };
}
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});
describe("current owner identity binding, already-verified session boundary", () => {
  it("preserves pending user/suspended organization for later disposition checks", async () => {
    const client = database();
    expect(await verifyLegacyCurrentOwnerIdentity(client as never, proof, session())).toEqual({
      outcome: "identity_matches",
      userStatus: "pending",
      organizationStatus: "suspended",
    });
    expect(client.query.mock.calls.every(([sql]) => !sql.includes("email"))).toBe(true);
  });
  it("matches an active user and organization without granting permissions", async () => {
    const client = database();
    client.identity.userStatus = "active";
    client.organization.status = "active";
    expect(await verifyLegacyCurrentOwnerIdentity(client as never, proof, session())).toEqual({
      outcome: "identity_matches",
      userStatus: "active",
      organizationStatus: "active",
    });
  });
  it.each(["suspended", "deleted", "unknown", null])("rejects current user %s", async (status) => {
    const client = database();
    client.identity.userStatus = status;
    expect(
      (await verifyLegacyCurrentOwnerIdentity(client as never, proof, session())).outcome,
    ).toBe("blocked");
  });
  it.each(["wrong user", "wrong org", "expired", "missing org"])(
    "rejects session %s before queries",
    async (change) => {
      const client = database();
      const value: Parameters<typeof verifyLegacyCurrentOwnerIdentity>[2] = session();
      if (change === "wrong user") value.workosUserId = "other";
      if (change === "wrong org") value.workosOrgId = "org_other";
      if (change === "missing org") value.workosOrgId = null;
      if (change === "expired") value.expiresAt = 1;
      expect((await verifyLegacyCurrentOwnerIdentity(client as never, proof, value)).outcome).toBe(
        "blocked",
      );
      expect(client.query).not.toHaveBeenCalled();
    },
  );
  it.each([
    "missing",
    "duplicate",
    "different owner",
    "different subject",
    "archived org",
    "wrong kind",
    "duplicate org",
    "missing org",
    "changed hash",
  ])("rejects %s", async (change) => {
    const client = database();
    if (change === "missing") client.identities.length = 0;
    if (change === "duplicate") client.identities.push({ ...client.identity });
    if (change === "different owner") client.identity.userId = proof.organizationId;
    if (change === "different subject") client.identity.providerUserId = "other";
    if (change === "archived org") client.organization.status = "archived";
    if (change === "wrong kind") client.organization.kind = "platform";
    if (change === "duplicate org") client.organizations.push({ ...client.organization });
    if (change === "missing org") client.organizations.length = 0;
    if (change === "changed hash")
      vi.mocked(readLegacyOwnershipTargetRow).mockResolvedValue({
        id: proof.externalIdentityId,
        rowStateSha256: "b".repeat(64),
      });
    expect(
      (await verifyLegacyCurrentOwnerIdentity(client as never, proof, session())).outcome,
    ).toBe("blocked");
  });
  it("rechecks expiry after the database read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
    const client = database();
    const value = session();
    vi.mocked(readLegacyOwnershipTargetRow).mockImplementation(async () => {
      vi.setSystemTime((value.expiresAt + 1) * 1000);
      return { id: proof.externalIdentityId, rowStateSha256: proof.externalIdentitySha256 };
    });
    expect((await verifyLegacyCurrentOwnerIdentity(client as never, proof, value)).outcome).toBe(
      "blocked",
    );
  });
});
