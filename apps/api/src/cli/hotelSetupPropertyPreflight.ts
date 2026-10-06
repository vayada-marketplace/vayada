import { assertHotelSetupLaunchSettingsPrivileges } from "../hotelSetupLaunchSettingsPrivileges.js";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import {
  assertHotelSetupCommandScope,
  assertHotelSetupLogoScope,
  assertHotelSetupLogoBootstrapScope,
  type HotelSetupPropertyPurpose,
} from "../hotelSetupCommandScope.js";
import { assertHotelSetupLogoPrivileges } from "../hotelSetupLogoPrivileges.js";
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
    operation: HotelSetupPropertyPurpose;
    actorUserId?: string;
    bootstrapPending?: true;
  },
) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await assertHotelSetupDatabaseIsolation(client);
    if (scope.operation === "property_logo") await assertHotelSetupLogoPrivileges(client);
    else if (scope.operation === "launch_settings")
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
    if (scope.operation === "property_logo") {
      const proof = scope.bootstrapPending
        ? assertHotelSetupLogoBootstrapScope
        : assertHotelSetupLogoScope;
      await proof(client, { ...scope, actorUserId: scope.actorUserId ?? "" });
    } else await assertHotelSetupCommandScope(client, { ...scope, operation: scope.operation });
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
        !(
          operation === "property_logo"
            ? /^vayada_next_hotel_setup_logo_[a-z0-9_]+$/
            : /^vayada_next_hotel_setup_property_[a-z0-9_]+$/
        ).test(login) ||
        Buffer.byteLength(login) > 63 ||
        !["currency", "currency_ready", "feature_hub", "launch_settings", "property_logo"].includes(
          operation ?? "",
        )
      )
        throw new Error("Invalid native credential configuration");
      if (
        operation === "property_logo" &&
        ![
          env.HOTEL_SETUP_COMMAND_PROPERTY_ID,
          env.HOTEL_SETUP_COMMAND_ORGANIZATION_ID,
          env.HOTEL_SETUP_COMMAND_ACTOR_USER_ID,
        ].every(
          (id) =>
            typeof id === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id),
        )
      )
        throw new Error("Invalid native logo binding");
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
        operation: operation as HotelSetupPropertyPurpose,
        actorUserId: env.HOTEL_SETUP_COMMAND_ACTOR_USER_ID,
      }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runHotelSetupPropertyPreflight();
