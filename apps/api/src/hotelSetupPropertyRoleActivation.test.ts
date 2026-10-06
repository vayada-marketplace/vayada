import { publishHotelSetupPropertySecret } from "./hotelSetupPropertySecretPublication.js";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { activateVerifiedHotelSetupPropertyRole } from "./hotelSetupPropertyRoleActivation.js";
import { checkHotelSetupPropertyCredential } from "./cli/hotelSetupPropertyPreflight.js";
vi.mock("./hotelSetupPropertyRoleStaging.js", () => ({
  lockHotelSetupPropertyBootstrapAuthority: vi.fn(),
}));
vi.mock("./cli/hotelSetupPropertyPreflight.js", () => ({
  checkHotelSetupPropertyCredential: vi.fn(),
}));
vi.mock("./hotelSetupPropertySecretPublication.js", () => ({
  publishHotelSetupPropertySecret: vi.fn(),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

it.each(
  [
    "success",
    "proof",
    "identityDrift",
    "commit",
    "secondary",
    "publication",
    "mutate",
    "readinessCommit",
  ].flatMap((mode) =>
    (["launch_settings", "property_logo"] as const)
      .filter((operation) => mode !== "commit" || operation !== "property_logo")
      .map((operation) => [operation, mode] as const),
  ),
)("guards %s activation and pending recovery on %s", async (operation, mode) => {
  const propertyId = "10000000-0000-4000-8000-000000000001";
  const logo = operation === "property_logo";
  const login = `vayada_next_hotel_setup_${logo ? "logo" : "property"}_${createHash("sha256").update(`${propertyId}:${operation}`).digest("hex").slice(0, 16)}_123456789abc`;
  const staged = {
    ...(mode === "mutate" && !logo ? { automatic: true as const } : {}),
    login,
    roleOid: 42,
    propertyId,
    operation,
    organizationId: "10000000-0000-4000-8000-000000000002",
    actorUserId: "10000000-0000-4000-8000-000000000003",
    ...(logo ? { assignmentXid: "123" } : {}),
  };
  const sql: string[] = [];
  class Client extends EventEmitter {
    async connect() {}
    async end() {}
    escapeIdentifier(name: string) {
      return `"${name}"`;
    }
    async query(text: string) {
      sql.push(text);
      if (text === "COMMIT" && mode === "commit")
        this.emit("error", new Error("private-diagnostic"));
      if (text.startsWith("SELECT session_user"))
        return {
          rows: [{ session_login: login, effective_login: login, role_oid: 42, effective_oid: 42 }],
        };
      return { rows: [{ oid: 42, verifier: "private-verifier" }] };
    }
  }
  vi.spyOn(pg, "Client").mockImplementation(function () {
    return new Client();
  } as unknown as typeof pg.Client);
  vi.mocked(checkHotelSetupPropertyCredential).mockImplementation(async (_client, proof) => {
    expect(Object.isFrozen(proof)).toBe(true);
    expect(proof.bootstrapPending).toBe(logo ? true : undefined);
    expect(sql.at(-1)).toContain("session_user::regrole::oid");
    // Logo committed its LOGIN and pending assignment atomically during staging.
    expect(sql.some((q) => q.startsWith("INSERT INTO platform.hotel_setup_property_scopes"))).toBe(
      !logo,
    );
    if (["proof", "identityDrift"].includes(mode)) throw new Error("private-diagnostic");
  });
  const input = {
    staged,
    databaseEndpoint: "postgresql://db.internal/test",
    adminDatabaseUrl: `postgresql://admin:${"a".repeat(36)}@db.internal/test?sslmode=verify-full`,
    nativeDatabaseUrl: `postgresql://${login}:${"b".repeat(36)}@db.internal/test?sslmode=verify-full`,
  };
  const originalStaged = { ...staged };
  const originalNativeUrl = input.nativeDatabaseUrl;
  const proveSecondary = vi.fn(async () => {
    if (mode === "mutate") {
      input.nativeDatabaseUrl = input.nativeDatabaseUrl.replace("b".repeat(36), "c".repeat(36));
      input.staged.propertyId = "10000000-0000-4000-8000-000000000004";
      input.staged.automatic = undefined;
    }
    if (mode === "secondary") throw new Error("private-diagnostic");
  });
  vi.mocked(publishHotelSetupPropertySecret).mockImplementation(async (publication) => {
    expect(publication.proveSecondary).toBe(logo ? undefined : proveSecondary);
    expect(publication.expectedAssignmentXid).toBe(logo ? "123" : undefined);
    expect(publication.nativeDatabaseUrl).toBe(originalNativeUrl);
    expect(publication.staged).toEqual(originalStaged);
    expect(proveSecondary).toHaveBeenCalledOnce();
    if (mode === "publication") throw new Error("private-diagnostic");
    if (mode === "readinessCommit")
      throw Object.assign(new Error("lost acknowledgement"), {
        code: "hotel_setup_property_readiness_inspection_required",
      });
    return { secretArn: "nonsecret-arn", versionId: "10000000-0000-4000-8000-000000000009" };
  });
  if (["secondary", "publication", "mutate", "readinessCommit"].includes(mode))
    Object.assign(input, { proveSecondary, publish: true });
  if (mode === "mutate")
    await expect(activateVerifiedHotelSetupPropertyRole(input)).resolves.toMatchObject(
      originalStaged,
    );
  else if (mode === "success")
    await expect(activateVerifiedHotelSetupPropertyRole(input)).resolves.toEqual(staged);
  else
    await expect(activateVerifiedHotelSetupPropertyRole(input)).rejects.toThrow(
      "requires recovery inspection",
    );
  expect(
    sql.some(
      (q) =>
        q.startsWith("ALTER ROLE") ||
        q.startsWith("UPDATE platform.hotel_setup_property_scopes") ||
        q.includes("pg_terminate_backend") ||
        q.includes("FROM pg_catalog.pg_authid"),
    ),
  ).toBe(false);

  if (mode === "secondary") expect(publishHotelSetupPropertySecret).not.toHaveBeenCalled();
  if (mode === "commit") expect(checkHotelSetupPropertyCredential).not.toHaveBeenCalled();
});
