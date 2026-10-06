import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { grantHotelSetupReadinessReaderColumns } from "./hotelSetupReadinessReaderGrant.js";

const databaseUrl = process.env.HOTEL_SETUP_APPROVED_BACKFILL_TEST_DATABASE_URL;
describe.runIf(databaseUrl)("offline reader readiness grants on owned TLS PostgreSQL", () => {
  it("requires inspected OIDs, grants only exact columns and inspects a lost COMMIT", async () => {
    const url = new URL(databaseUrl!);
    if (
      url.hostname !== "127.0.0.1" ||
      !url.pathname.startsWith("/vay1092_approved_backfill_test") ||
      url.search !== "?sslmode=verify-full"
    )
      throw new Error("Owned disposable verified TLS fixture required");
    const endpoint = new URL(url);
    endpoint.username = endpoint.password = endpoint.search = "";
    const admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    const readers = ["vayada_next_hotel_setup_creation_reader", "vayada_next_hotel_setup_reader"];
    const owned = new Map<string, number>();
    const originalQuery = pg.Client.prototype.query;
    let fault = false;
    try {
      expect(
        (await admin.query("SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[])", [readers]))
          .rows,
      ).toEqual([]);
      for (const reader of readers) {
        await admin.query(
          `CREATE ROLE ${admin.escapeIdentifier(reader)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${admin.escapeLiteral(randomBytes(36).toString("base64url"))}`,
        );
        const oid: number = (
          await admin.query("SELECT oid FROM pg_roles WHERE rolname=$1", [reader])
        ).rows[0].oid;
        owned.set(reader, oid);
      }
      const input = {
        adminDatabaseUrl: url.toString(),
        databaseEndpoint: endpoint.toString(),
        expectedCreationReaderOid: owned.get(readers[0]!)!,
        expectedPropertyReaderOid: owned.get(readers[1]!)!,
      };
      await expect(
        grantHotelSetupReadinessReaderColumns({
          ...input,
          expectedCreationReaderOid: input.expectedCreationReaderOid + 1,
        }),
      ).rejects.toThrow("requires recovery inspection");
      expect(
        (
          await admin.query(
            "SELECT column_name FROM information_schema.column_privileges WHERE grantee=ANY($1::text[])",
            [readers],
          )
        ).rows,
      ).toEqual([]);
      vi.spyOn(pg.Client.prototype, "query").mockImplementation(async function (
        this: pg.Client,
        ...args: unknown[]
      ) {
        const result = await (
          originalQuery as unknown as (...values: unknown[]) => Promise<unknown>
        ).apply(this, args);
        if (args[0] === "COMMIT" && !fault) {
          fault = true;
          throw new Error("Synthetic lost COMMIT acknowledgement");
        }
        return result;
      } as never);
      await expect(grantHotelSetupReadinessReaderColumns(input)).resolves.toMatchObject({
        status: "grant_commit_inspected",
      });
      expect(fault).toBe(true);
      vi.restoreAllMocks();
      for (const [index, login] of readers.entries()) {
        const grants = (
          await admin.query(
            "SELECT table_name,column_name,privilege_type,is_grantable FROM information_schema.column_privileges WHERE grantee=$1 ORDER BY column_name",
            [login],
          )
        ).rows;
        expect(grants).toEqual(
          ["credential_ready_at", "credential_role_oid", "credential_secret_version"].map(
            (column_name) => ({
              table_name:
                index === 0 ? "hotel_setup_creation_scopes" : "hotel_setup_property_scopes",
              column_name,
              privilege_type: "SELECT",
              is_grantable: "NO",
            }),
          ),
        );
      }
      await expect(grantHotelSetupReadinessReaderColumns(input)).resolves.toMatchObject({
        status: "granted",
      });
    } finally {
      vi.restoreAllMocks();
      await admin.query("ROLLBACK");
      for (const [login, oid] of owned) {
        expect(
          (await admin.query("SELECT oid FROM pg_roles WHERE rolname=$1", [login])).rows,
        ).toEqual([{ oid }]);
        await admin.query(`DROP OWNED BY ${admin.escapeIdentifier(login)}`);
        await admin.query(`DROP ROLE ${admin.escapeIdentifier(login)}`);
      }
      await admin.end();
    }
  }, 30_000);
});
