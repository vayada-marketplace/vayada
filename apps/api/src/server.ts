import { createPgIdentityRepository, createWorkOSVerifier } from "@vayada/backend-auth";
import {
  createPgEntitlementRepository,
  createPgRolePermissionRepository,
} from "@vayada/backend-authorization";

import { buildApp, type ApiAuthOptions } from "./app.js";
import { type ApiConfig, loadConfig } from "./config.js";
import { createCompatibilityPublicHotelQuoteRepository } from "./routes/aiHotelQuotes.js";
import { createPgPublicHotelProfileRepository } from "./routes/aiHotels.js";
import { createCompatibilityPmsBookingReservationsReadRepository } from "./routes/bookingReservations.js";
import {
  createHttpPmsGuestFormSettingsSync,
  createPgBookingSettingsReadRepository,
} from "./routes/bookingSettings.js";
import { createPgMarketplaceDiscoveryReadRepository } from "./routes/marketplaceDiscovery.js";

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

const publicHotelProfileRepository = config.bookingDatabaseUrl
  ? createPgPublicHotelProfileRepository({
      connectionString: config.bookingDatabaseUrl,
      bookingHostBase: config.bookingHostBase,
    })
  : undefined;

const bookingSettingsRepository = config.bookingDatabaseUrl
  ? createPgBookingSettingsReadRepository({
      connectionString: config.bookingDatabaseUrl,
    })
  : undefined;

const bookingGuestFormSettingsSync = config.pmsApiUrl
  ? createHttpPmsGuestFormSettingsSync({
      pmsApiUrl: config.pmsApiUrl,
    })
  : undefined;

const app = buildApp({
  auth: buildAuthOptions(config.auth),
  bookingReservationsRepository: config.bookingReservationsReadDatabaseUrl
    ? createCompatibilityPmsBookingReservationsReadRepository({
        connectionString: config.bookingReservationsReadDatabaseUrl,
      })
    : undefined,
  bookingSettingsRepository,
  bookingSettingsWriteRepository: bookingSettingsRepository,
  bookingGuestFormSettingsSync,
  marketplaceDiscoveryRepository: config.marketplaceDatabaseUrl
    ? createPgMarketplaceDiscoveryReadRepository({
        connectionString: config.marketplaceDatabaseUrl,
      })
    : undefined,
  marketplaceDiscoveryAllowedOrigins: config.marketplaceDiscoveryAllowedOrigins,
  publicHotelProfileRepository,
  publicHotelQuoteRepository: publicHotelProfileRepository
    ? createCompatibilityPublicHotelQuoteRepository({
        profileRepository: publicHotelProfileRepository,
        pmsPublicApiUrl: config.pmsPublicApiUrl,
      })
    : undefined,
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
