import pg from "pg";
import * as helperOwner from "./hotelSetupHelperOwnerGrants.js";
import { afterEach, expect, it, vi } from "vitest";
import { lockHotelSetupCreationPermissions } from "./hotelSetupMembership.js";
import {
  hotelSetupOrganizationRolePrefix,
  stageHotelSetupOrganizationRole,
} from "./hotelSetupOrganizationRoleStaging.js";

vi.mock("./hotelSetupMembership.js", () => ({ lockHotelSetupCreationPermissions: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
const input = {
  adminDatabaseUrl: `postgresql://admin:${"p".repeat(36)}@database.example/target?sslmode=verify-full`,
  databaseEndpoint: "postgresql://database.example/target",
  scope: {
    organizationId: "11111111-1111-4111-8111-111111111111",
    actorUserId: "22222222-2222-4222-8222-222222222222",
  },
};

function fixture(mode = "success") {
  let notice: ((value: { code: string }) => void) | undefined;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM identity.organizations"))
      return { rows: mode === "organization" ? [] : [{ id: input.scope.organizationId }] };
    if (sql.includes("WHERE organization_id=$1"))
      return { rows: mode === "assignment" ? [{}] : [] };
    if (sql.includes("left(rolname")) return { rows: mode === "staged" ? [{}] : [] };
    if (sql.includes("SELECT NOT prosecdef AS safe"))
      return {
        rows:
          mode === "helper_missing" ? [] : [{ safe: mode !== "helper_definer" }, { safe: true }],
      };
    if (sql.startsWith("GRANT CONNECT") && mode === "warning") notice?.({ code: "01007" });
    if (sql === "COMMIT" && mode === "commit") throw new Error("lost acknowledgement");
    return { rows: sql.startsWith("SELECT oid") ? [{ oid: 123 }] : [] };
  });
  const end = vi.fn(async () => {});
  vi.spyOn(pg, "Client").mockImplementation(function () {
    return {
      query,
      end,
      connect: vi.fn(),
      escapeIdentifier: (name: string) => `"${name}"`,
      on: (name: string, listener: typeof notice) => {
        if (name === "notice") notice = listener;
      },
    } as unknown as pg.Client;
  });
  vi.mocked(lockHotelSetupCreationPermissions).mockResolvedValue(
    mode === "actor" ? null : ["hotel_catalog.setup.manage"],
  );
  return { query, end };
}

it("stages a disabled organization identity with canonical scope and no publication", async () => {
  const f = fixture();
  const staged = await stageHotelSetupOrganizationRole(input);
  expect(staged).toMatchObject({ ...input.scope, roleOid: 123 });
  expect(staged.login).toMatch(
    new RegExp(`^${hotelSetupOrganizationRolePrefix(input.scope.organizationId)}[a-f0-9]{12}$`),
  );
  const sql = f.query.mock.calls.map(([value]) => value);
  expect(sql.find((value) => value.startsWith("CREATE ROLE"))).toContain(
    "NOLOGIN NOINHERIT NOSUPERUSER",
  );
  expect(sql.some((value) => /PASSWORD|INSERT INTO|DELETE FROM|UPDATE platform/.test(value))).toBe(
    false,
  );
  expect(sql.at(-1)).toBe("COMMIT");
  expect(lockHotelSetupCreationPermissions).toHaveBeenCalledWith(expect.anything(), input.scope);
  expect(f.end).toHaveBeenCalledOnce();
});

it.each([
  "organization",
  "actor",
  "assignment",
  "staged",
  "helper_missing",
  "helper_definer",
  "warning",
  "commit",
])("rejects %s without adopting or removing an earlier attempt", async (mode) => {
  const f = fixture(mode);
  await expect(stageHotelSetupOrganizationRole(input)).rejects.toThrow(
    mode === "commit"
      ? "Hotel setup organization staging requires recovery inspection"
      : "Hotel setup organization staging failed",
  );
  const sql = f.query.mock.calls.map(([value]) => value);
  expect(sql.at(-1)).toBe(mode === "commit" ? "COMMIT" : "ROLLBACK");
  expect(sql.some((value) => /DROP ROLE|ALTER ROLE|DELETE FROM/.test(value))).toBe(false);
  if (["assignment", "staged", "actor", "organization"].includes(mode))
    expect(sql.some((value) => value.startsWith("CREATE ROLE"))).toBe(false);
  expect(f.end).toHaveBeenCalledOnce();
});

it("rejects malformed scopes and mismatched endpoints before constructing a client", async () => {
  const constructor = vi.spyOn(pg, "Client");
  for (const drift of [
    { scope: { ...input.scope, actorUserId: "invalid" } },
    { adminDatabaseUrl: input.adminDatabaseUrl.replace("/target", "/other") },
    { adminDatabaseUrl: input.adminDatabaseUrl.replace("verify-full", "require") },
  ])
    await expect(stageHotelSetupOrganizationRole({ ...input, ...drift })).rejects.toThrow(
      "Hotel setup organization staging failed",
    );
  expect(constructor).not.toHaveBeenCalled();
});

it("grants via the owner only after confirmed disabled staging, never after an uncertain commit", async () => {
  const holder = {} as pg.Client;
  vi.spyOn(helperOwner, "assertHotelSetupBootstrapLock").mockResolvedValue(undefined);
  for (const mode of ["success", "commit"]) {
    const f = fixture(mode);
    const grant = vi
      .spyOn(helperOwner, "grantFreshHotelSetupHelpers")
      .mockImplementation(async (value) => {
        expect(f.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
        expect(value).toMatchObject({ holder, roleOid: 123, kind: "organization" });
      });
    const attempt = stageHotelSetupOrganizationRole({
      ...input,
      helperOwner: { holder, databaseUrl: "synthetic owner" },
    });
    if (mode === "success") {
      await attempt;
      expect(grant).toHaveBeenCalledOnce();
    } else {
      await expect(attempt).rejects.toThrow("requires recovery inspection");
      expect(grant).not.toHaveBeenCalled();
    }
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("GRANT EXECUTE"))).toBe(false);
    grant.mockRestore();
  }
});

it("preserves exact helper-grant recovery coordinates after durable staging", async () => {
  const f = fixture();
  vi.spyOn(helperOwner, "assertHotelSetupBootstrapLock").mockResolvedValue(undefined);
  const failure = new helperOwner.HotelSetupHelperGrantInspection({
    phase: "grant_attempted",
    login: "synthetic",
    roleOid: 123,
    catalog: "unavailable",
    commitAttempted: true,
  });
  vi.spyOn(helperOwner, "grantFreshHotelSetupHelpers").mockRejectedValue(failure);
  await expect(
    stageHotelSetupOrganizationRole({
      ...input,
      helperOwner: { holder: {} as pg.Client, databaseUrl: "synthetic owner" },
    }),
  ).rejects.toBe(failure);
  expect(f.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
});
