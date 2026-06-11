import { createPgIdentityRepository, createWorkOSVerifier } from "@vayada/backend-auth";
import {
  createPgEntitlementRepository,
  createPgRolePermissionRepository,
} from "@vayada/backend-authorization";

import { buildApp, type ApiAuthOptions } from "./app.js";
import { type ApiConfig, loadConfig } from "./config.js";
import { createOpenAIAskModel } from "./platform/askIntelligence.js";
import { createPgBookingWebEventSink } from "./platform/bookingWebEvents.js";
import { createPgIdentityLifecycleCommandBus } from "./platform/identityLifecycle.js";
import { createPgProductAuditSink } from "./platform/productAudit.js";
import { createWorkOSAuthKitClient } from "./platform/workosAuthKit.js";
import {
  createPgWorkosWebhookStore,
  createWorkosWebhookVerifier,
} from "./platform/workosWebhooks.js";
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

const askModelProvider =
  config.askIntelligence.provider === "openai"
    ? await createOpenAIAskModel(config.askIntelligence)
    : undefined;

const app = buildApp({
  auth: buildAuthOptions(config.auth),
  authSession:
    config.auth && config.authSession
      ? {
          authKitClient: createWorkOSAuthKitClient({
            apiKey: config.authSession.workosApiKey,
            clientId: config.authSession.workosClientId,
            cookiePassword: config.authSession.authCookieSecret,
          }),
          identityRepository: createPgIdentityRepository({
            connectionString: config.auth.databaseUrl,
          }),
          lifecycleCommandBus: createPgIdentityLifecycleCommandBus({
            connectionString: config.auth.databaseUrl,
          }),
          productAuditSink: createPgProductAuditSink({
            connectionString: config.auth.databaseUrl,
          }),
          tokenVerifier: createWorkOSVerifier({
            jwksUrl: config.auth.workosJwksUrl,
            issuer: config.auth.workosIssuer,
            audience: config.auth.workosAudience,
          }),
          callbackUrl: config.authSession.authCallbackUrl,
          callbackReturnUrl: config.authSession.authSuccessUrl,
          logoutReturnUrl: config.authSession.authLogoutUrl,
          allowedOrigins: config.authSession.authAllowedOrigins,
          requiredOrganizationKind: "platform",
          cookieSecure: config.authSession.authCookieSecure,
          cookieDomain: config.authSession.authCookieDomain,
          legacyMarketplaceJwtSecret: config.authSession.authLegacyMarketplaceJwtSecret,
        }
      : undefined,
  workosWebhooks:
    config.auth && config.authSession?.workosWebhookSecret
      ? {
          secret: config.authSession.workosWebhookSecret,
          verifier: createWorkosWebhookVerifier({
            apiKey: config.authSession.workosApiKey,
            secret: config.authSession.workosWebhookSecret,
          }),
          store: createPgWorkosWebhookStore({
            connectionString: config.auth.databaseUrl,
          }),
        }
      : undefined,
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
  bookingPublicApiUrl: config.bookingPublicApiUrl,
  pmsPublicApiUrl: config.pmsPublicApiUrl,
  askModel: askModelProvider?.model,
  askModelMetadata: askModelProvider?.metadata,
  legacyCheckoutCommandProxyEnabled: config.bookingWebLegacyCheckoutCommandProxyEnabled,
  bookingWebAttributionSink: config.auth
    ? createPgBookingWebEventSink({
        connectionString: config.auth.databaseUrl,
      })
    : undefined,
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
