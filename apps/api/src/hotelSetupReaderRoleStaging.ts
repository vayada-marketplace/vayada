import pg from "pg";
import {
  HOTEL_SETUP_READER_AUDIT_COLUMNS,
  HOTEL_SETUP_READER_READ_COLUMNS,
} from "./hotelSetupReaderPrivileges.js";

/** Separate provisioner only; never wire admin credentials into the command service. */
export async function stageHotelSetupReaderRole(config: pg.ClientConfig) {
  const admin = new pg.Client(config);
  // PostgreSQL can report an unauthorized GRANT as a warning and still commit.
  let incompleteGrant = false;
  let connectionFailed = false;
  admin.on("error", () => {
    connectionFailed = true;
  });
  admin.on("notice", (notice) => {
    if (notice.code === "01007") incompleteGrant = true;
  });
  const role = "vayada_next_hotel_setup_reader";
  try {
    await admin.connect();
    if (connectionFailed) throw new Error("Hotel setup reader staging connection unavailable");
    await admin.query("BEGIN");
    // CREATE deliberately rejects an existing role instead of adopting or repairing it.
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER
      NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    const database = (
      await admin.query<{ name: string }>("SELECT pg_catalog.current_database() AS name")
    ).rows[0]!.name;
    await admin.query(`GRANT CONNECT ON DATABASE ${admin.escapeIdentifier(database)} TO ${role}`);
    await admin.query(`GRANT USAGE ON SCHEMA identity,platform TO ${role}`);
    for (const [relation, columns] of Object.entries(HOTEL_SETUP_READER_READ_COLUMNS))
      await admin.query(`GRANT SELECT (${columns.join(",")}) ON ${relation} TO ${role}`);
    await admin.query(
      `GRANT INSERT (${HOTEL_SETUP_READER_AUDIT_COLUMNS.join(",")}) ON platform.product_audit_events TO ${role}`,
    );
    if (connectionFailed) throw new Error("Hotel setup reader staging connection unavailable");
    if (incompleteGrant) throw new Error("Hotel setup reader staging grants incomplete");
    await admin.query("COMMIT");
    if (connectionFailed) throw new Error("Hotel setup reader staging commit outcome uncertain");
  } catch (error) {
    await admin.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await admin.end();
  }
  // No password, LOGIN, secret version, assignment or command is created here.
}
