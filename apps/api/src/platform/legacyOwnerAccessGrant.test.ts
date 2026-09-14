import type { GrantIdentityAccessCommand } from "@vayada/backend-auth";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPgIdentityLifecycleCommandBus,
  grantIdentityAccessWithClient,
} from "./identityLifecycle.js";

const userId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const command: GrantIdentityAccessCommand = {
  commandType: "identity.access.grant",
  commandId: "synthetic-grant",
  idempotencyKey: "synthetic-grant",
  audit: {
    actor: { kind: "system", service: "test" },
    source: "web",
    requestId: "synthetic",
    reason: "Synthetic access grant hold test",
    requestedAt: "2026-09-14T00:00:00.000Z",
  },
  payload: {
    userId,
    organization: {
      organizationId,
      kind: "hotel_group",
      name: "Synthetic",
      websiteUrl: "https://example.test",
    },
    membership: {
      roleKey: "hotel_owner",
      propertyAccessMode: "all",
      permissionKeys: ["pms.booking.update"],
    },
    permissionGrants: [
      {
        organizationKind: "hotel_group",
        roleKey: "hotel_owner",
        permissionKey: "pms.booking.update",
      },
    ],
    resourceLinks: [
      {
        product: "pms",
        resourceType: "pms_hotel",
        resourceId: organizationId,
        relationship: "owner",
      },
    ],
  },
};

afterEach(() => vi.restoreAllMocks());

function fixture(protection: boolean | Error, exists = true, failMembership = false) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT id FROM identity.users"))
      return { rows: exists ? [{ id: userId }] : [] };
    if (sql.includes("legacy_owner_bootstrap_receipts")) {
      if (protection instanceof Error) throw protection;
      return { rows: [{ protected: protection }] };
    }
    if (sql.includes("INSERT INTO identity.organizations"))
      return { rows: [{ id: organizationId }] };
    if (failMembership && sql.includes("INSERT INTO identity.organization_memberships"))
      throw new Error("membership failed");
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as pg.PoolClient;
  vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue(client as never);
  const bus = createPgIdentityLifecycleCommandBus({ connectionString: "postgresql://unused" });
  return { query, release, client, bus };
}

describe("prepared-owner access grant hold", () => {
  it.each([true, new Error("private receipt error")])(
    "rejects protected or unreadable subject before any grants: %s",
    async (protection) => {
      const { query, release, bus } = fixture(protection);
      await expect(bus.execute(command)).rejects.toThrow(
        /^Legacy owner account reconciliation required$/,
      );
      expect(query.mock.calls.map(([sql]) => sql)).toEqual([
        "BEGIN",
        "SELECT id FROM identity.users WHERE id = $1 FOR KEY SHARE",
        expect.stringContaining("ANY(owner_user_ids)"),
        "ROLLBACK",
      ]);
      expect(query).toHaveBeenCalledWith(expect.stringContaining("ANY(owner_user_ids)"), [userId]);
      expect(release).toHaveBeenCalledOnce();
      await bus.close();
    },
  );

  it("rejects missing subject without receipt reads, org creation or late-user adoption", async () => {
    const { query, bus } = fixture(false, false);
    await expect(bus.execute(command)).rejects.toThrow("Cannot grant access to a missing user");
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "SELECT id FROM identity.users WHERE id = $1 FOR KEY SHARE",
      "ROLLBACK",
    ]);
    await bus.close();
  });

  it("guards direct helper consumers without owning their transaction", async () => {
    const { query, release, client, bus } = fixture(true);
    await expect(grantIdentityAccessWithClient(client, command.payload)).rejects.toThrow(
      "Legacy owner account reconciliation required",
    );
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "SELECT id FROM identity.users WHERE id = $1 FOR KEY SHARE",
      expect.stringContaining("ANY(owner_user_ids)"),
    ]);
    expect(release).not.toHaveBeenCalled();
    await bus.close();
  });

  it("preserves ordinary org, membership, resource and permission grants after the check", async () => {
    const { query, bus } = fixture(false);
    await expect(bus.execute(command)).resolves.toMatchObject({
      status: "accepted",
      userId,
      organizationId,
    });
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements.slice(0, 3)).toEqual([
      "BEGIN",
      "SELECT id FROM identity.users WHERE id = $1 FOR KEY SHARE",
      expect.stringContaining("ANY(owner_user_ids)"),
    ]);
    for (const table of [
      "organizations",
      "organization_memberships",
      "organization_resource_links",
      "role_permission_grants",
    ]) {
      expect(statements.some((sql) => sql.includes(`INSERT INTO identity.${table}`))).toBe(true);
    }
    expect(query).toHaveBeenLastCalledWith("COMMIT");
    await bus.close();
  });

  it("leaves success commit/release to the direct helper caller", async () => {
    const { query, release, client, bus } = fixture(false);
    await expect(grantIdentityAccessWithClient(client, command.payload)).resolves.toBe(
      organizationId,
    );
    expect(query.mock.calls.some(([sql]) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))).toBe(
      false,
    );
    expect(release).not.toHaveBeenCalled();
    await bus.close();
  });

  it("rolls back prior org changes if a downstream grant fails", async () => {
    const { query, release, bus } = fixture(false, true, true);
    await expect(bus.execute(command)).rejects.toThrow("membership failed");
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
    await bus.close();
  });

  it("does not block revocation while receipt storage is unavailable", async () => {
    const { query, bus } = fixture(new Error("unavailable"));
    await expect(
      bus.execute({
        ...command,
        commandType: "identity.access.revoke",
        payload: {
          userId,
          organizationId,
          membershipStatus: "suspended",
          resourceLinks: command.payload.resourceLinks?.map((link) => ({
            ...link,
            status: "suspended",
          })),
        },
      }),
    ).resolves.toMatchObject({ status: "accepted", userId });
    expect(query.mock.calls.some(([sql]) => sql.includes("legacy_owner_bootstrap_receipts"))).toBe(
      false,
    );
    expect(query).toHaveBeenLastCalledWith("COMMIT");
    await bus.close();
  });
});
