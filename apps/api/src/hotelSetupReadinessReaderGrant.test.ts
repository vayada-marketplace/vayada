import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { grantHotelSetupReadinessReaderColumns } from "./hotelSetupReadinessReaderGrant.js";
import { hotelSetupOrganizationConnection } from "./hotelSetupOrganizationRoleStaging.js";

vi.mock("./hotelSetupOrganizationRoleStaging.js", async (load) => ({
  ...(await load<typeof import("./hotelSetupOrganizationRoleStaging.js")>()),
  hotelSetupOrganizationConnection: vi.fn(),
}));
afterEach(() => {
  vi.resetAllMocks();
});

it.each(["success", "wrongOid", "unsafeGrant", "notice", "commitLost", "inspectionDrift"])(
  "limits reader readiness grants on %s",
  async (mode) => {
    const queries: string[] = [];
    let connections = 0;
    class Client extends EventEmitter {
      connect = vi.fn(async () => undefined);
      end = vi.fn(async () => undefined);
      escapeIdentifier = (name: string) => `"${name}"`;
      inspection = ++connections > 1;
      async query(sql: string, params?: unknown[]) {
        queries.push(sql);
        if (sql.includes("pg_try_advisory_lock(8734516)")) return { rows: [{ held: true }] };
        if (sql.includes("SELECT r.oid")) {
          expect(sql).not.toContain("FOR SHARE OF r");
          expect(params).toEqual(
            params?.[0] === 41
              ? [41, "vayada_next_hotel_setup_creation_reader"]
              : [42, "vayada_next_hotel_setup_reader"],
          );
          return {
            rows:
              mode === "wrongOid" || (mode === "inspectionDrift" && this.inspection)
                ? []
                : [{ oid: params?.[0] }],
          };
        }
        if (sql.includes("SELECT bool_and")) {
          expect(params?.[2]).toEqual([
            "credential_role_oid",
            "credential_secret_version",
            "credential_ready_at",
          ]);
          return { rows: [{ safe: mode !== "unsafeGrant" }] };
        }
        if (sql.startsWith("GRANT") && mode === "notice") this.emit("notice", { code: "01007" });
        if (sql === "COMMIT" && ["commitLost", "inspectionDrift"].includes(mode))
          throw new Error("lost acknowledgement");
        return { rows: [] };
      }
    }
    const clients: Client[] = [];
    vi.mocked(hotelSetupOrganizationConnection).mockImplementation(() => {
      const client = new Client();
      clients.push(client);
      return client as never;
    });
    const run = grantHotelSetupReadinessReaderColumns({
      adminDatabaseUrl: "operational-input",
      databaseEndpoint: "fixed-endpoint",
      expectedCreationReaderOid: 41,
      expectedPropertyReaderOid: 42,
    });
    if (["success", "commitLost"].includes(mode))
      await expect(run).resolves.toMatchObject({
        status: mode === "success" ? "granted" : "grant_commit_inspected",
        readers: [
          {
            login: "vayada_next_hotel_setup_creation_reader",
            roleOid: 41,
            relation: "platform.hotel_setup_creation_scopes",
          },
          {
            login: "vayada_next_hotel_setup_reader",
            roleOid: 42,
            relation: "platform.hotel_setup_property_scopes",
          },
        ],
      });
    else await expect(run).rejects.toThrow("requires recovery inspection");
    expect(queries.filter((sql) => sql.startsWith("GRANT"))).toEqual(
      mode === "wrongOid"
        ? []
        : [
            'GRANT SELECT(credential_role_oid,credential_secret_version,credential_ready_at) ON platform.hotel_setup_creation_scopes TO "vayada_next_hotel_setup_creation_reader"',
            'GRANT SELECT(credential_role_oid,credential_secret_version,credential_ready_at) ON platform.hotel_setup_property_scopes TO "vayada_next_hotel_setup_reader"',
          ],
    );
    expect(queries.some((sql) => /CREATE|ALTER|DROP|DELETE|UPDATE|REVOKE/.test(sql))).toBe(false);
    expect(clients.every((client) => client.end.mock.calls.length === 1)).toBe(true);
  },
);

it.each([
  [undefined, 42],
  [41, undefined],
  [0, 42],
  [41, 4294967296],
  [41, 41],
])("requires separately inspected reader OIDs %s %s", async (creation, property) => {
  await expect(
    grantHotelSetupReadinessReaderColumns({
      adminDatabaseUrl: "unused",
      databaseEndpoint: "unused",
      expectedCreationReaderOid: creation as number,
      expectedPropertyReaderOid: property as number,
    }),
  ).rejects.toThrow("requires recovery inspection");
  expect(hotelSetupOrganizationConnection).not.toHaveBeenCalled();
});

it("refuses reader grants while live provisioning holds the lock", async () => {
  const query = vi.fn(async (_sql: string) => ({ rows: [{ held: false }] }));
  const end = vi.fn(async () => undefined);
  vi.mocked(hotelSetupOrganizationConnection).mockReturnValue({
    query,
    end,
    connect: async () => undefined,
    on: vi.fn(),
  } as never);
  await expect(
    grantHotelSetupReadinessReaderColumns({
      adminDatabaseUrl: "operational",
      databaseEndpoint: "fixed",
      expectedCreationReaderOid: 41,
      expectedPropertyReaderOid: 42,
    }),
  ).rejects.toThrow("requires recovery inspection");
  expect(query.mock.calls.every(([sql]) => !/pg_authid|GRANT/.test(sql))).toBe(true);
  expect(end).toHaveBeenCalledOnce();
});
