import type pg from "pg";
import { hotelSetupOrganizationConnection } from "./hotelSetupOrganizationRoleStaging.js";
import { isHotelSetupInspectedOid } from "./hotelSetupApprovedReadinessBackfill.js";

const readers = [
  {
    login: "vayada_next_hotel_setup_creation_reader",
    relation: "platform.hotel_setup_creation_scopes",
  },
  { login: "vayada_next_hotel_setup_reader", relation: "platform.hotel_setup_property_scopes" },
] as const;
const columns = [
  "credential_role_oid",
  "credential_secret_version",
  "credential_ready_at",
] as const;

/** Protected offline schema cutover only: no ordinary reader, schema or table-wide grants. */
export async function grantHotelSetupReadinessReaderColumns(input: {
  adminDatabaseUrl: string;
  databaseEndpoint: string;
  expectedCreationReaderOid: number;
  expectedPropertyReaderOid: number;
}) {
  const oids = Object.freeze([input.expectedCreationReaderOid, input.expectedPropertyReaderOid]);
  const { adminDatabaseUrl, databaseEndpoint } = input;
  let admin: pg.Client | undefined;
  let failed = false,
    incomplete = false,
    commitAttempted = false;
  const inspect = async (client: pg.Client, requireGrants: boolean) => {
    for (const [index, reader] of readers.entries()) {
      const identity = await client.query(
        `SELECT r.oid FROM pg_catalog.pg_authid r WHERE oid=$1::oid AND rolname=$2
         AND rolcanlogin AND rolvaliduntil IS NULL AND NOT rolinherit AND NOT rolsuper
         AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
         AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid)
         AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting WHERE setrole=r.oid)
         AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend
           WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
         FOR SHARE OF r`,
        [oids[index], reader.login],
      );
      if (identity.rows.length !== 1) throw new Error();
      if (requireGrants) {
        const grants = await client.query<{ safe: boolean }>(
          `SELECT bool_and(pg_catalog.has_column_privilege($1,$2,column_name,'SELECT')
            AND NOT pg_catalog.has_column_privilege($1,$2,column_name,'SELECT WITH GRANT OPTION')) AS safe
           FROM pg_catalog.unnest($3::text[]) AS column_name`,
          [reader.login, reader.relation, columns],
        );
        if (grants.rows.length !== 1 || grants.rows[0]?.safe !== true) throw new Error();
      }
    }
  };
  const receipt = (status: "granted" | "grant_commit_inspected") => ({
    status,
    readers: readers.map((reader, index) => ({ ...reader, roleOid: oids[index], columns })),
  });
  try {
    if (!oids.every(isHotelSetupInspectedOid) || oids[0] === oids[1]) throw new Error();
    admin = hotelSetupOrganizationConnection(adminDatabaseUrl, databaseEndpoint);
    admin.on("error", () => {
      failed = true;
    });
    admin.on("notice", (notice) => {
      if (notice.code === "01007") incomplete = true;
    });
    await admin.connect();
    await admin.query("BEGIN");
    await inspect(admin, false);
    for (const reader of readers)
      await admin.query(
        `GRANT SELECT(${columns.join(",")}) ON ${reader.relation} TO ${admin.escapeIdentifier(reader.login)}`,
      );
    await inspect(admin, true);
    if (failed || incomplete) throw new Error();
    commitAttempted = true;
    await admin.query("COMMIT");
    if (failed) throw new Error();
    return receipt("granted");
  } catch {
    await admin?.query("ROLLBACK").catch(() => undefined);
    await admin?.end().catch(() => undefined);
    admin = undefined;
    if (commitAttempted) {
      let client: pg.Client | undefined;
      let inspectionFailed = false;
      try {
        client = hotelSetupOrganizationConnection(adminDatabaseUrl, databaseEndpoint);
        client.on("error", () => {
          inspectionFailed = true;
        });
        await client.connect();
        await client.query("BEGIN");
        await inspect(client, true);
        if (inspectionFailed) throw new Error();
        await client.query("ROLLBACK");
        if (inspectionFailed) throw new Error();
        return receipt("grant_commit_inspected");
      } catch {
        await client?.query("ROLLBACK").catch(() => undefined);
      } finally {
        await client?.end().catch(() => undefined);
      }
    }
    throw new Error("Hotel setup readiness reader grant requires recovery inspection");
  } finally {
    await admin?.end().catch(() => undefined);
  }
}
