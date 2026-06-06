import { createPgIdentityRepository, createWorkOSVerifier } from "@vayada/backend-auth";
import {
  createPgEntitlementRepository,
  createPgRolePermissionRepository,
} from "@vayada/backend-authorization";

import { buildApp, type ApiAuthOptions } from "./app.js";
import { type ApiConfig, loadConfig } from "./config.js";
import { createPgPublicHotelProfileRepository } from "./routes/aiHotels.js";
import { createPgBookingSettingsReadRepository } from "./routes/bookingSettings.js";

const config = loadConfig();

function buildAuthOptions(auth: ApiConfig["auth"]): ApiAuthOptions | undefined {
  if (!auth) {
    return undefined;
  }

  return {
    verifier: createWorkOSVerifier({
      jwksUrl: auth.workosJwksUrl,
      issuer: auth.workosIssuer,
      audience: auth.workosAudience,
    }),
    repository: createPgIdentityRepository({
      connectionString: auth.databaseUrl,
    }),
    rolePermissionRepository: createPgRolePermissionRepository({
      connectionString: auth.databaseUrl,
    }),
    entitlementRepository: createPgEntitlementRepository({
      connectionString: auth.databaseUrl,
    }),
  };
}

const app = buildApp({
  auth: buildAuthOptions(config.auth),
  bookingSettingsRepository: config.bookingDatabaseUrl
    ? createPgBookingSettingsReadRepository({
        connectionString: config.bookingDatabaseUrl,
      })
    : undefined,
  publicHotelProfileRepository: config.bookingDatabaseUrl
    ? createPgPublicHotelProfileRepository({
        connectionString: config.bookingDatabaseUrl,
        bookingHostBase: config.bookingHostBase,
      })
    : undefined,
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
