import { assertHotelSetupLaunchSettingsPrivileges } from "../hotelSetupLaunchSettingsPrivileges.js";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import {
  assertHotelSetupCommandScope,
  type HotelSetupOperation,
} from "../hotelSetupCommandScope.js";
import { parseHotelSetupDatabaseUrl } from "../hotelSetupCommandServiceConfig.js";
import { assertHotelSetupCurrencyPrivileges } from "../hotelSetupCurrencyPrivileges.js";
import { assertHotelSetupFeatureHubPrivileges } from "../hotelSetupFeatureHubPrivileges.js";
import {
  assertHotelSetupDatabaseIsolation,
  runHotelSetupCredentialPreflight,
} from "./hotelSetupReaderPreflight.js";

/** Catalogs first; only reviewed scope functions may run in the subsequent lock transaction. */
export async function checkHotelSetupPropertyCredential(
  client: pg.Client,
  scope: {
    propertyId: string;
    organizationId: string;
    operation: HotelSetupOperation;
  },
) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await assertHotelSetupDatabaseIsolation(client);
    if (scope.operation === "launch_settings")
      await assertHotelSetupLaunchSettingsPrivileges(client);
    else if (scope.operation === "feature_hub") await assertHotelSetupFeatureHubPrivileges(client);
    else await assertHotelSetupCurrencyPrivileges(client, scope.operation);
  } finally {
    await client.query("ROLLBACK");
  }
  // The existing assignment/Owner check needs row locks and READ COMMITTED.
  // No business command, audit, grant or provisioning is invoked; never commit.
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
  try {
    await assertHotelSetupCommandScope(client, scope);
  } finally {
    await client.query("ROLLBACK");
  }
}

export async function runHotelSetupPropertyPreflight(env: NodeJS.ProcessEnv = process.env) {
  const operation = env.HOTEL_SETUP_COMMAND_OPERATION;
  return runHotelSetupCredentialPreflight(
    "hotel_setup_property",
    () => {
      const login = env.HOTEL_SETUP_COMMAND_DATABASE_LOGIN ?? "";
      if (
        !/^vayada_next_hotel_setup_property_[a-z0-9_]+$/.test(login) ||
        Buffer.byteLength(login) > 63 ||
        !["currency", "currency_ready", "feature_hub", "launch_settings"].includes(operation ?? "")
      )
        throw new Error("Invalid native credential configuration");
      return parseHotelSetupDatabaseUrl(
        env.HOTEL_SETUP_COMMAND_DATABASE_URL ?? "",
        env.HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT ?? "",
        login,
      );
    },
    (client) =>
      checkHotelSetupPropertyCredential(client, {
        propertyId: env.HOTEL_SETUP_COMMAND_PROPERTY_ID ?? "",
        organizationId: env.HOTEL_SETUP_COMMAND_ORGANIZATION_ID ?? "",
        operation: operation as HotelSetupOperation,
      }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runHotelSetupPropertyPreflight();
