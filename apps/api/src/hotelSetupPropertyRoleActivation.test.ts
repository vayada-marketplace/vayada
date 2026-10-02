import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { activateVerifiedHotelSetupPropertyRole } from "./hotelSetupPropertyRoleActivation.js";
import { runHotelSetupPropertyPreflight } from "./cli/hotelSetupPropertyPreflight.js";
vi.mock("./hotelSetupPropertyRoleStaging.js", () => ({
  lockHotelSetupPropertyBootstrapAuthority: vi.fn(),
}));
vi.mock("./cli/hotelSetupPropertyPreflight.js", () => ({
  runHotelSetupPropertyPreflight: vi.fn(),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

it.each(["success", "proof", "identityDrift", "commit"])(
  "guards activation and cleanup on %s",
  async (mode) => {
    const propertyId = "10000000-0000-4000-8000-000000000001";
    const operation = "launch_settings" as const;
    const login = `vayada_next_hotel_setup_property_${createHash("sha256").update(`${propertyId}:${operation}`).digest("hex").slice(0, 16)}_123456789abc`;
    const staged = {
      login,
      roleOid: 42,
      propertyId,
      operation,
      organizationId: "10000000-0000-4000-8000-000000000002",
      actorUserId: "10000000-0000-4000-8000-000000000003",
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
                rolpassword:
                  mode === "identityDrift" ? "other-private-verifier" : "private-verifier",
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
              },
            ],
          };
        return { rows: [{ oid: 42, verifier: "private-verifier" }] };
      }
    }
    vi.spyOn(pg, "Client").mockImplementation(function () {
      return new Client();
    } as unknown as typeof pg.Client);
    vi.mocked(runHotelSetupPropertyPreflight).mockImplementation(async () => {
      expect(sql.at(-1)).toBe("COMMIT");
      expect(
        sql.some((q) => q.startsWith("INSERT INTO platform.hotel_setup_property_scopes")),
      ).toBe(true);
      return mode === "success" ? 0 : 1;
    });
    const input = {
      staged,
      databaseEndpoint: "postgresql://db.internal/test",
      adminDatabaseUrl: `postgresql://admin:${"a".repeat(36)}@db.internal/test?sslmode=verify-full`,
      nativeDatabaseUrl: `postgresql://${login}:${"b".repeat(36)}@db.internal/test?sslmode=verify-full`,
    };
    if (mode === "success")
      await expect(activateVerifiedHotelSetupPropertyRole(input)).resolves.toEqual(staged);
    else
      await expect(activateVerifiedHotelSetupPropertyRole(input)).rejects.toThrow(
        mode === "proof" ? "verification failed" : "requires recovery inspection",
      );
    expect(sql.some((q) => q.startsWith("ALTER ROLE"))).toBe(mode === "proof" || mode === "commit");
    expect(sql.some((q) => q.includes("pg_terminate_backend"))).toBe(
      mode === "proof" || mode === "commit",
    );
    if (mode === "commit") expect(runHotelSetupPropertyPreflight).not.toHaveBeenCalled();
  },
);
