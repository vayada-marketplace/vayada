import {
  authenticateHotelSetupPropertyLogin,
  publishHotelSetupPropertySecret,
} from "./hotelSetupPropertySecretPublication.js";
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
  authenticateHotelSetupPropertyLogin: vi.fn(),
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
    "actorDrift",
  ].flatMap((mode) =>
    (["launch_settings", "property_logo"] as const)
      .filter((operation) => mode !== "actorDrift" || operation === "property_logo")
      .filter((operation) => mode !== "commit" || operation !== "property_logo")
      .map((operation) => [operation, mode] as const),
  ),
)("guards %s activation and cleanup on %s", async (operation, mode) => {
  const propertyId = "10000000-0000-4000-8000-000000000001";
  const login = `vayada_next_hotel_setup_${operation === "property_logo" ? "logo" : "property"}_${createHash("sha256").update(`${propertyId}:${operation}`).digest("hex").slice(0, 16)}_123456789abc`;
  const staged = {
    ...(mode === "mutate" && operation !== "property_logo" ? { automatic: true as const } : {}),
    login,
    roleOid: 42,
    propertyId,
    operation,
    organizationId: "10000000-0000-4000-8000-000000000002",
    actorUserId: "10000000-0000-4000-8000-000000000003",
    ...(operation === "property_logo" ? { assignmentXid: "123" } : {}),
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
      if (text.startsWith("SELECT rolcanlogin"))
        return {
          rows: [
            {
              rolcanlogin: true,
              rolpassword: mode === "identityDrift" ? "other-private-verifier" : "private-verifier",
            },
          ],
        };
      if (text.startsWith("SELECT property_id"))
        return {
          rows: [
            {
              property_id: propertyId,
              organization_id: staged.organizationId,
              operation_class: operation,
              actor_user_id: mode === "actorDrift" ? propertyId : staged.actorUserId,
            },
          ],
        };
      return { rows: [{ oid: 42, verifier: "private-verifier" }] };
    }
  }
  vi.spyOn(pg, "Client").mockImplementation(function () {
    return new Client();
  } as unknown as typeof pg.Client);
  vi.mocked(authenticateHotelSetupPropertyLogin).mockImplementation(async (_credential, prove) => {
    await prove?.(new Client() as unknown as pg.Client);
  });
  vi.mocked(checkHotelSetupPropertyCredential).mockImplementation(async (_client, proof) => {
    expect(Object.isFrozen(proof)).toBe(true);
    expect(proof.bootstrapPending).toBe(operation === "property_logo" ? true : undefined);
    if (operation !== "property_logo") {
      expect(sql.at(-1)).toBe("COMMIT");
      expect(
        sql.some((q) => q.startsWith("INSERT INTO platform.hotel_setup_property_scopes")),
      ).toBe(true);
    }
    if (["proof", "identityDrift", "actorDrift"].includes(mode))
      throw new Error("private-diagnostic");
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
    expect(publication.expectedVerifier).toBe(
      operation === "property_logo" ? undefined : "private-verifier",
    );
    expect(publication.expectedAssignmentXid).toBe(
      operation === "property_logo" ? "123" : undefined,
    );
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
      operation !== "property_logo" && ["proof", "secondary"].includes(mode)
        ? "verification failed"
        : "requires recovery inspection",
    );
  expect(sql.some((q) => q.startsWith("ALTER ROLE"))).toBe(
    operation !== "property_logo" && ["proof", "commit", "secondary", "publication"].includes(mode),
  );
  expect(sql.some((q) => q.includes("pg_terminate_backend"))).toBe(
    operation !== "property_logo" && ["proof", "commit", "secondary", "publication"].includes(mode),
  );
  if (operation === "property_logo") {
    expect(sql.some((q) => /FROM pg_catalog.pg_authid/.test(q))).toBe(false);
    expect(sql.some((q) => /ALTER ROLE|INSERT INTO|UPDATE platform/.test(q))).toBe(false);
  }
  if (mode === "secondary") expect(publishHotelSetupPropertySecret).not.toHaveBeenCalled();
  if (mode === "commit") expect(checkHotelSetupPropertyCredential).not.toHaveBeenCalled();
});
