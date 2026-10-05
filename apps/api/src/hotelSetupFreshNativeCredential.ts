import type pg from "pg";
import { parseHotelSetupDatabaseUrl } from "./hotelSetupCommandServiceConfig.js";
import { hotelSetupOrganizationConnection } from "./hotelSetupOrganizationRoleStaging.js";

/** A new authenticated connection for each proof; never accepts a caller-supplied client. */
export async function proveFreshHotelSetupNativeCredential(
  input: { nativeDatabaseUrl: string; databaseEndpoint: string; login: string; roleOid: number },
  prove?: (client: pg.Client) => Promise<void>,
) {
  if (!Number.isInteger(input.roleOid) || input.roleOid <= 0) throw new Error();
  parseHotelSetupDatabaseUrl(input.nativeDatabaseUrl, input.databaseEndpoint, input.login);
  const client = hotelSetupOrganizationConnection(input.nativeDatabaseUrl, input.databaseEndpoint);
  let failed = false;
  client.on("error", () => {
    failed = true;
  });
  try {
    await client.connect();
    const result = await client.query<{
      session_login: string;
      effective_login: string;
      role_oid: number;
      effective_oid: number;
    }>(
      "SELECT session_user::text AS session_login,current_user::text AS effective_login,session_user::regrole::oid AS role_oid,current_user::regrole::oid AS effective_oid",
    );
    const identity = result.rows[0];
    if (
      failed ||
      result.rows.length !== 1 ||
      identity?.session_login !== input.login ||
      identity.effective_login !== input.login ||
      identity.role_oid !== input.roleOid ||
      identity.effective_oid !== input.roleOid
    )
      throw new Error();
    await prove?.(client);
  } finally {
    await client.end();
  }
  if (failed) throw new Error();
}
