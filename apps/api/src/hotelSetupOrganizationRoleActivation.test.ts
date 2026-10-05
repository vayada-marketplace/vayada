import pg from "pg";
import * as helperOwner from "./hotelSetupHelperOwnerGrants.js";
import { afterEach, expect, it, vi } from "vitest";
import { checkHotelSetupCreationCredential } from "./cli/hotelSetupCreationPreflight.js";
import { activateVerifiedHotelSetupOrganizationRole } from "./hotelSetupOrganizationRoleActivation.js";
import {
  hotelSetupOrganizationRolePrefix,
  lockHotelSetupOrganizationBootstrapAuthority,
} from "./hotelSetupOrganizationRoleStaging.js";
import { publishHotelSetupOrganizationSecret } from "./hotelSetupOrganizationSecretPublication.js";

vi.mock("./cli/hotelSetupCreationPreflight.js", () => ({
  checkHotelSetupCreationCredential: vi.fn(),
}));
vi.mock("./hotelSetupOrganizationSecretPublication.js", () => ({
  publishHotelSetupOrganizationSecret: vi.fn(),
}));
vi.mock("./hotelSetupOrganizationRoleStaging.js", async (load) => ({
  ...(await load<typeof import("./hotelSetupOrganizationRoleStaging.js")>()),
  lockHotelSetupOrganizationBootstrapAuthority: vi.fn(),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
const organizationId = "11111111-1111-4111-8111-111111111111";
const actorUserId = "22222222-2222-4222-8222-222222222222";
const login = `${hotelSetupOrganizationRolePrefix(organizationId)}123456789abc`;
const input = {
  adminDatabaseUrl: `postgresql://admin:${"a".repeat(36)}@db.internal/target?sslmode=verify-full`,
  nativeDatabaseUrl: `postgresql://${login}:${"b".repeat(36)}@db.internal/target?sslmode=verify-full`,
  databaseEndpoint: "postgresql://db.internal/target",
  staged: { login, roleOid: 42, organizationId, actorUserId },
};

function fixture(mode: string) {
  let commits = 0;
  const adminQuery = vi.fn(async (sql: string) => {
    if (sql.includes("pg_try_advisory_lock_shared(8734516)"))
      return { rows: [{ held: mode !== "bootstrapBusy" }] };
    if (sql.startsWith("SELECT oid")) return { rows: mode === "unsafe" ? [] : [{ oid: 42 }] };
    if (sql === "COMMIT" && ++commits === 1 && ["commit", "rolledBack"].includes(mode))
      throw new Error("lost commit response");
    return { rows: [] };
  });
  const nativeQuery = vi.fn(async () => ({ rows: [{ oid: mode === "nativeOid" ? 999 : 42 }] }));
  const adminEnd = vi.fn(async () => {}),
    nativeEnd = vi.fn(async () => {});
  let instances = 0;
  vi.spyOn(pg, "Client").mockImplementation(function () {
    const native = instances++ === 1;
    return {
      query: native ? nativeQuery : adminQuery,
      end: native ? nativeEnd : adminEnd,
      connect: vi.fn(async () => {
        if (native && mode === "connect") throw new Error("private diagnostic");
      }),
      on: vi.fn(),
      escapeIdentifier: (name: string) => `"${name}"`,
    } as unknown as pg.Client;
  });
  vi.mocked(lockHotelSetupOrganizationBootstrapAuthority).mockImplementation(async () => {
    if (mode === "actor") throw new Error("revoked actor");
  });
  vi.mocked(checkHotelSetupCreationCredential).mockImplementation(async () => {
    if (mode === "proof") throw new Error("private diagnostic");
  });
  const secondary = vi.fn(async () => {
    if (mode === "rollback") throw new Error("private diagnostic");
  });
  vi.mocked(publishHotelSetupOrganizationSecret).mockImplementation(async () => {
    if (["publication", "readyCommit", "changedOid", "changedVerifier", "retarget"].includes(mode))
      throw new Error("uncertain publication");
    return {
      secretArn: "sanitized-reference",
      versionId: "33333333-3333-4333-8333-333333333333",
    };
  });
  return { adminQuery, adminEnd, nativeEnd, secondary };
}

it.each([
  "success",
  "actor",
  "unsafe",
  "connect",
  "nativeOid",
  "proof",
  "rollback",
  "publication",
  "readyCommit",
  "changedOid",
  "changedVerifier",
  "retarget",
  "commit",
  "rolledBack",
])("keeps organization admission and pending recovery exact on %s", async (mode) => {
  const f = fixture(mode);
  const result = activateVerifiedHotelSetupOrganizationRole({
    ...input,
    proveSecondary: f.secondary,
  });
  if (mode === "success") {
    await expect(result).resolves.toMatchObject({
      ...input.staged,
      publication: { versionId: "33333333-3333-4333-8333-333333333333" },
    });
    expect(checkHotelSetupCreationCredential).toHaveBeenCalledWith(expect.anything(), {
      organizationId,
      actorUserId,
    });
    expect(f.secondary).toHaveBeenCalledWith(expect.anything(), { organizationId, actorUserId });
    const firstCommit = f.adminQuery.mock.calls.findIndex(([sql]) => sql === "COMMIT");
    expect(f.adminQuery.mock.invocationCallOrder[firstCommit]).toBeLessThan(
      vi.mocked(checkHotelSetupCreationCredential).mock.invocationCallOrder[0]!,
    );
    expect(f.secondary.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(publishHotelSetupOrganizationSecret).mock.invocationCallOrder[0]!,
    );
  } else
    await expect(result).rejects.toThrow(
      ["actor", "unsafe"].includes(mode)
        ? "Hotel setup organization activation verification failed"
        : "Hotel setup organization activation requires recovery inspection",
    );
  const sql = f.adminQuery.mock.calls.map(([value]) => value);
  expect(sql.some((value) => value.includes("FROM pg_catalog.pg_authid"))).toBe(false);
  expect(
    sql.some(
      (value) =>
        value.startsWith("ALTER ROLE") ||
        value.startsWith("DELETE FROM") ||
        value.includes("pg_terminate_backend"),
    ),
  ).toBe(false);
  if (
    [
      "actor",
      "unsafe",
      "connect",
      "nativeOid",
      "proof",
      "rollback",
      "commit",
      "rolledBack",
    ].includes(mode)
  )
    expect(publishHotelSetupOrganizationSecret).not.toHaveBeenCalled();
  expect(f.adminEnd).toHaveBeenCalledOnce();
});

it("requires an exact staged identity and compatible secondary proof before connecting", async () => {
  const constructor = vi.spyOn(pg, "Client");
  for (const drift of [
    { staged: { ...input.staged, roleOid: 0 } },
    { staged: { ...input.staged, login: login.replace("123456789abc", "arbitrary") } },
    { nativeDatabaseUrl: input.nativeDatabaseUrl.replace("db.internal", "other.internal") },
    { proveSecondary: undefined },
  ])
    await expect(
      activateVerifiedHotelSetupOrganizationRole({
        ...input,
        proveSecondary: vi.fn(),
        ...drift,
      } as Parameters<typeof activateVerifiedHotelSetupOrganizationRole>[0]),
    ).rejects.toThrow("activation verification failed");
  expect(constructor).not.toHaveBeenCalled();
});

it.each(["success", "bootstrapBusy", "holderLost"])(
  "owns an activation lock independently of the coordinator: %s",
  async (mode) => {
    const f = fixture(mode);
    const assertHolder = vi
      .spyOn(helperOwner, "assertHotelSetupBootstrapLock")
      .mockImplementation(async () => {
        if (mode === "holderLost") throw Error("lost holder");
      });
    const secondary = vi.fn(async () => undefined);
    const attempt = activateVerifiedHotelSetupOrganizationRole({
      ...input,
      proveSecondary: secondary,
      bootstrapHolder: {} as pg.Client,
    });
    if (mode === "success") {
      await attempt;
      expect(secondary).toHaveBeenCalledOnce();
      expect(assertHolder).toHaveBeenCalledOnce();
    } else {
      await expect(attempt).rejects.toThrow();
      expect(secondary).not.toHaveBeenCalled();
      expect(publishHotelSetupOrganizationSecret).not.toHaveBeenCalled();
    }
    expect(f.adminQuery.mock.calls[0]?.[0]).toContain("pg_try_advisory_lock_shared(8734516)");
  },
);
