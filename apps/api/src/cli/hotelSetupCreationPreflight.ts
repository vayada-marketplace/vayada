import { pathToFileURL } from "node:url";
import type pg from "pg";
import { assertHotelSetupCreationScope } from "../hotelSetupCommandScope.js";
import { parseHotelSetupDatabaseUrl } from "../hotelSetupCommandServiceConfig.js";
import { assertHotelSetupCreationPrivileges } from "../hotelSetupCreationPrivileges.js";
import { lockHotelSetupCreationPermissions } from "../hotelSetupMembership.js";
import {
  assertHotelSetupDatabaseIsolation,
  runHotelSetupCredentialPreflight,
} from "./hotelSetupReaderPreflight.js";

/** Release-only credential/authority check; no business write and never commit. */
export async function checkHotelSetupCreationCredential(
  client: pg.Client,
  scope: { organizationId: string; actorUserId: string },
) {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
  try {
    await assertHotelSetupDatabaseIsolation(client);
    await assertHotelSetupCreationPrivileges(client);
    await assertHotelSetupCreationScope(client, scope.organizationId);
    if (!(await lockHotelSetupCreationPermissions(client, scope)))
      throw new Error("Hotel setup creation owner preflight failed");
  } finally {
    await client.query("ROLLBACK");
  }
}

export async function runHotelSetupCreationPreflight(env: NodeJS.ProcessEnv = process.env) {
  return runHotelSetupCredentialPreflight(
    "hotel_setup_creation",
    () => {
      const login = env.HOTEL_SETUP_COMMAND_DATABASE_LOGIN ?? "";
      if (!/^vayada_next_hotel_setup_org_[a-z0-9_]+$/.test(login) || Buffer.byteLength(login) > 63)
        throw new Error("Invalid native creation credential configuration");
      return parseHotelSetupDatabaseUrl(
        env.HOTEL_SETUP_COMMAND_DATABASE_URL ?? "",
        env.HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT ?? "",
        login,
      );
    },
    (client) =>
      checkHotelSetupCreationCredential(client, {
        organizationId: env.HOTEL_SETUP_COMMAND_ORGANIZATION_ID ?? "",
        actorUserId: env.HOTEL_SETUP_COMMAND_ACTOR_USER_ID ?? "",
      }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runHotelSetupCreationPreflight();
