import type pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import * as organization from "./hotelSetupOrganizationRoleStaging.js";
import * as property from "./hotelSetupPropertyRoleStaging.js";
import * as organizationActivation from "./hotelSetupOrganizationRoleActivation.js";
import * as propertyActivation from "./hotelSetupPropertyRoleActivation.js";
import {
  discoverHotelSetupAutomaticCandidates,
  type HotelSetupAutomaticCandidate,
} from "./hotelSetupAutomaticDiscovery.js";
import { reconcileHotelSetupAutomaticScopes } from "./hotelSetupAutomaticReconciliation.js";

afterEach(() => vi.restoreAllMocks());
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const versionId = "00000000-0000-4000-8000-000000000099" as const;
const candidate = (n: number, actor = n): HotelSetupAutomaticCandidate => ({
  scopeId: id(n),
  organizationId: id(n),
  actorUserId: id(actor),
});
const compare = (a: HotelSetupAutomaticCandidate, b: HotelSetupAutomaticCandidate) =>
  a.scopeId.localeCompare(b.scopeId) ||
  a.organizationId.localeCompare(b.organizationId) ||
  a.actorUserId.localeCompare(b.actorUserId);

function fixture(candidates = [candidate(1)]) {
  let cursor: HotelSetupAutomaticCandidate | undefined;
  let disconnected = false;
  const assignments = new Map<string, boolean>();
  const prefixes = new Set<string>();
  const claimed = new Map<string, boolean>();
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  let operatorMember = false;
  const admin = {
    on: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(async () => {
      disconnected = true;
    }),
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes("pg_has_role")) return { rows: [{ safe: !operatorMember }] };
      if (sql.includes("pg_try_advisory_lock"))
        return { rows: [{ claimed: claimed.get(String(values[0])) ?? true }] };
      if (sql.startsWith("SELECT scope_id"))
        return {
          rows: [
            {
              scope_id: cursor?.scopeId ?? null,
              organization_id: cursor?.organizationId ?? null,
              actor_user_id: cursor?.actorUserId ?? null,
            },
          ],
        };
      if (sql.includes("SELECT DISTINCT")) {
        expect(sql).toContain('ORDER BY "scopeId","organizationId","actorUserId" LIMIT 2');
        expect(values).toEqual([
          cursor?.scopeId ?? null,
          cursor?.organizationId ?? null,
          cursor?.actorUserId ?? null,
        ]);
        return {
          rows: candidates
            .filter((c) => !cursor || compare(c, cursor) > 0)
            .sort(compare)
            .slice(0, 2),
        };
      }
      if (sql.startsWith("UPDATE platform.hotel_setup_reconciliation_cursors")) {
        cursor =
          values[1] === null
            ? undefined
            : {
                scopeId: String(values[1]),
                organizationId: String(values[2]),
                actorUserId: String(values[3]),
              };
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("IS TRUE AS ready")) {
        const key = `${values[1] ?? values[0]}:${values[2] ?? "creation"}`;
        return { rows: assignments.has(key) ? [{ ready: assignments.get(key) }] : [] };
      }
      if (sql.startsWith("SELECT oid"))
        return { rows: prefixes.has(String(values[0])) ? [{ oid: 50 }] : [] };
      return { rows: [] };
    }),
  };
  vi.spyOn(organization, "hotelSetupOrganizationConnection").mockReturnValue(
    admin as unknown as pg.Client,
  );
  const orgAuthority = vi
    .spyOn(organization, "lockHotelSetupOrganizationBootstrapAuthority")
    .mockResolvedValue();
  const propertyAuthority = vi
    .spyOn(property, "lockHotelSetupPropertyBootstrapAuthority")
    .mockResolvedValue();
  const stageOrg = vi
    .spyOn(organization, "stageHotelSetupOrganizationRole")
    .mockImplementation(async ({ scope }) => ({
      ...scope,
      login: "vayada_next_hotel_setup_org_fixture",
      roleOid: 51,
    }));
  const stageProperty = vi
    .spyOn(property, "stageHotelSetupPropertyRole")
    .mockImplementation(async ({ scope }) => ({
      ...scope,
      login: "vayada_next_hotel_setup_property_fixture",
      roleOid: 52,
    }));
  const activateOrg = vi
    .spyOn(organizationActivation, "activateVerifiedHotelSetupOrganizationRole")
    .mockImplementation(async (input) => {
      assignments.set(`${input.staged.organizationId}:creation`, true);
      return { ...input.staged, publication: { secretArn: "fixture", versionId } };
    });
  const activateProperty = vi
    .spyOn(propertyActivation, "activateVerifiedHotelSetupPropertyRole")
    .mockImplementation(async (input) => {
      assignments.set(`${input.staged.propertyId}:${input.staged.operation}`, true);
      return { ...input.staged, publication: { secretArn: "fixture", versionId } };
    });
  const config = {
    adminDatabaseUrl: `postgresql://admin:${"x".repeat(36)}@127.0.0.1/test?sslmode=verify-full`,
    databaseEndpoint: "postgresql://127.0.0.1/test",
    proveOrganization: vi.fn(),
    proveProperty: vi.fn(),
  };
  return {
    admin,
    queries,
    assignments,
    prefixes,
    claimed,
    config,
    setOperatorMember(member: boolean) {
      operatorMember = member;
    },
    orgAuthority,
    propertyAuthority,
    stageOrg,
    stageProperty,
    activateOrg,
    activateProperty,
    get disconnected() {
      return disconnected;
    },
  };
}

it("advances beyond ready and ineligible earlier scopes, wraps, and never duplicates ready roles", async () => {
  const f = fixture([candidate(1), candidate(2), candidate(3), candidate(4)]);
  f.assignments.set(`${id(1)}:creation`, true);
  f.orgAuthority.mockImplementation(async (_admin, scope) => {
    if (scope.organizationId === id(2)) throw new Error();
  });
  expect(
    (await reconcileHotelSetupAutomaticScopes({ ...f.config, mode: "organization" })).receipts.map(
      (r) => r.status,
    ),
  ).toEqual(["existing_ready", "pending_authority"]);
  expect(f.stageOrg).not.toHaveBeenCalled();
  await reconcileHotelSetupAutomaticScopes({ ...f.config, mode: "organization" });
  expect(f.stageOrg.mock.calls.map(([v]) => v.scope.organizationId)).toEqual([id(3), id(4)]);
  expect(
    (await reconcileHotelSetupAutomaticScopes({ ...f.config, mode: "organization" })).receipts,
  ).toEqual([]);
  await reconcileHotelSetupAutomaticScopes({ ...f.config, mode: "organization" });
  await reconcileHotelSetupAutomaticScopes({ ...f.config, mode: "organization" });
  expect(f.stageOrg).toHaveBeenCalledTimes(2);
  expect(f.disconnected).toBe(true);
});

it("selects a later qualified current Owner without trusting a raw role key", async () => {
  const f = fixture([candidate(1, 1), candidate(1, 2), candidate(2, 3)]);
  f.orgAuthority.mockImplementation(async (_admin, scope) => {
    if (scope.actorUserId === id(1)) throw new Error();
  });
  await reconcileHotelSetupAutomaticScopes({ ...f.config, mode: "organization" });
  expect(f.stageOrg).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      scope: {
        organizationId: id(1),
        actorUserId: id(2),
      },
    }),
  );
  expect(f.activateOrg.mock.calls[0]![0].staged.actorUserId).toBe(id(2));
});

it("does not adopt pending assignments or orphan roles even after an actor change", async () => {
  const f = fixture([candidate(1, 1), candidate(1, 2), candidate(2, 3)]);
  f.assignments.set(`${id(1)}:creation`, false);
  f.prefixes.add(organization.hotelSetupOrganizationRolePrefix(id(2)));
  for (let i = 0; i < 2; i++) {
    const result = await reconcileHotelSetupAutomaticScopes({ ...f.config, mode: "organization" });
    expect(result.receipts.every((r) => r.status === "inspection_required")).toBe(true);
  }
  expect(f.orgAuthority).not.toHaveBeenCalled();
  expect(f.stageOrg).not.toHaveBeenCalled();
  expect(f.activateOrg).not.toHaveBeenCalled();
});

it("keeps unknown assignment/publication outcomes inspection-only on replay", async () => {
  const f = fixture([candidate(1, 1), candidate(1, 2)]);
  f.activateOrg.mockImplementation(async (input) => {
    f.assignments.set(`${input.staged.organizationId}:creation`, false);
    throw new Error("sensitive AWS/pg details");
  });
  const result = await reconcileHotelSetupAutomaticScopes({ ...f.config, mode: "organization" });
  expect(result.receipts.map((r) => r.status)).toEqual([
    "inspection_required",
    "inspection_required",
  ]);
  expect(JSON.stringify(result)).not.toContain("sensitive");
  expect(f.stageOrg).toHaveBeenCalledTimes(1);
  expect(f.activateOrg).toHaveBeenCalledTimes(1);
  await reconcileHotelSetupAutomaticScopes({ ...f.config, mode: "organization" });
  await reconcileHotelSetupAutomaticScopes({ ...f.config, mode: "organization" });
  expect(f.stageOrg).toHaveBeenCalledTimes(1);
});

it("never swaps the actor or retries after an ambiguous staging COMMIT", async () => {
  const f = fixture([candidate(1, 1), candidate(1, 2)]);
  f.stageOrg.mockImplementation(async ({ scope }) => {
    f.prefixes.add(organization.hotelSetupOrganizationRolePrefix(scope.organizationId));
    throw new Error("staging COMMIT response lost");
  });
  const result = await reconcileHotelSetupAutomaticScopes({ ...f.config, mode: "organization" });
  expect(result.receipts.map((r) => r.status)).toEqual([
    "inspection_required",
    "inspection_required",
  ]);
  expect(f.stageOrg).toHaveBeenCalledTimes(1);
  expect(f.activateOrg).not.toHaveBeenCalled();
});

it("prepares only three consumed property purposes and retains the exact candidate actor", async () => {
  const f = fixture();
  const receipt = await reconcileHotelSetupAutomaticScopes({ ...f.config, mode: "property" });
  expect(receipt.receipts.map((r) => r.purpose)).toEqual([
    "launch_settings",
    "currency_ready",
    "feature_hub",
  ]);
  expect(f.stageOrg).not.toHaveBeenCalled();
  expect(f.stageProperty).toHaveBeenCalledTimes(3);
  for (const [input] of f.activateProperty.mock.calls) {
    expect(input.staged).toMatchObject({
      propertyId: id(1),
      organizationId: id(1),
      actorUserId: id(1),
      automatic: true,
    });
    expect(input.proveSecondary).toBe(f.config.proveProperty);
    expect(input.publish).toBe(true);
    const url = new URL(input.nativeDatabaseUrl);
    expect(url.username).toBe(input.staged.login);
    expect(Buffer.byteLength(url.password)).toBeGreaterThanOrEqual(32);
    expect(url.search).toBe("?sslmode=verify-full");
  }
});

it("uses persisted Hotel Operations and current canonical/product joins for property discovery only", async () => {
  const f = fixture();
  await discoverHotelSetupAutomaticCandidates(f.admin as unknown as pg.Client, "property");
  const sql = f.queries.find((q) => q.sql.includes("SELECT DISTINCT"))!.sql;
  expect(sql).toContain("'hotel_operations'=ANY(intent.selected_tracks)");
  expect(sql).toContain("catalog.relationship='owner' AND catalog.status='active'");
  expect(sql).toContain("pms.relationship='owner' AND pms.status='active'");
  expect(sql).toContain("member.pms_access_enabled AND member.booking_access_enabled");
  await discoverHotelSetupAutomaticCandidates(f.admin as unknown as pg.Client, "organization");
  expect(f.queries.at(-1)!.sql).not.toContain("selected_tracks");
  expect(f.queries.at(-1)!.sql).not.toContain("role_key");
});

it("fails before provisioning if cursor persistence or the advisory pass claim fails", async () => {
  const f = fixture();
  f.claimed.set("hotel_setup_reconciliation_pass:organization", false);
  expect(await reconcileHotelSetupAutomaticScopes({ ...f.config, mode: "organization" })).toEqual({
    status: "busy",
    receipts: [],
  });
  f.claimed.clear();
  const original = f.admin.query.getMockImplementation()!;
  f.admin.query.mockImplementation(async (sql, values) => {
    if (sql.startsWith("UPDATE platform.hotel_setup_reconciliation_cursors"))
      throw new Error("lost cursor commit");
    return original(sql, values);
  });
  await expect(
    reconcileHotelSetupAutomaticScopes({ ...f.config, mode: "organization" }),
  ).rejects.toThrow();
  expect(f.stageOrg).not.toHaveBeenCalled();
});

it("does not enter a busy scope and releases every successfully acquired claim", async () => {
  const f = fixture([candidate(1), candidate(2)]);
  f.claimed.set(`hotel_setup_reconciliation_scope:organization:${id(1)}:creation`, false);
  await reconcileHotelSetupAutomaticScopes({ ...f.config, mode: "organization" });
  expect(f.stageOrg.mock.calls.map(([v]) => v.scope.organizationId)).toEqual([id(2)]);
  const unlocks = f.queries.filter((q) => q.sql.includes("pg_advisory_unlock"));
  expect(unlocks.map((q) => q.values[0])).toEqual([
    `hotel_setup_reconciliation_scope:organization:${id(2)}:creation`,
  ]);
});

it("stops starting new attempts at the deadline and requires the selected rollback proof", async () => {
  const f = fixture([candidate(1), candidate(2)]);
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.activateOrg.mockImplementation(async (input) => {
    now = 120_000;
    return { ...input.staged, publication: { secretArn: "fixture", versionId } };
  });
  await reconcileHotelSetupAutomaticScopes({ ...f.config, mode: "organization" });
  expect(f.stageOrg).toHaveBeenCalledTimes(1);
  await expect(
    reconcileHotelSetupAutomaticScopes({ ...f.config, mode: "property", proveProperty: undefined }),
  ).rejects.toThrow();
  expect(f.stageProperty).not.toHaveBeenCalled();
});

it("fails loudly before discovery when the operator is a member of any native scope", async () => {
  const f = fixture([candidate(1)]);
  f.setOperatorMember(true);
  await expect(
    reconcileHotelSetupAutomaticScopes({ ...f.config, mode: "organization" }),
  ).rejects.toThrow("must not be a native scope member");
  expect(f.queries.some(({ sql }) => sql.includes("SELECT DISTINCT"))).toBe(false);
  expect(f.stageOrg).not.toHaveBeenCalled();
  expect(f.disconnected).toBe(true);
});
