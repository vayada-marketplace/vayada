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
import { createTargetBookingReservationsReadRepository } from "./platform/bookingReservations.js";
import { createPgProviderWebhookStore } from "./platform/providerWebhooks.js";
import { createWorkOSAuthKitClient } from "./platform/workosAuthKit.js";
import {
  createPgWorkosWebhookStore,
  createWorkosWebhookVerifier,
} from "./platform/workosWebhooks.js";
import {
  createCompatibilityPublicHotelQuoteRepository,
  createTargetPublicHotelQuoteRepository,
} from "./routes/aiHotelQuotes.js";
import {
  createPgPublicHotelProfileRepository,
  createTargetPublicHotelProfileRepository,
} from "./routes/aiHotels.js";
import { createTargetPmsOperationsReadRepository } from "./domains/pmsOperationsReadModel.js";
import {
  createPgBookingWebAffiliateHotelResolver,
  createPgBookingWebAffiliateRepository,
} from "./routes/bookingWebAffiliate.js";
import { createCompatibilityPmsBookingReservationsReadRepository } from "./routes/bookingReservations.js";
import { createTargetBookingWebCalendarRepository } from "./routes/bookingWebPublic.js";
import {
  createHttpPmsGuestFormSettingsSync,
  createPgBookingSettingsReadRepository,
  createPgTargetBookingSettingsRepository,
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

const publicHotelProfileRepository =
  config.publicHotelProfileSource === "target"
    ? createTargetPublicHotelProfileRepository({
        connectionString: config.targetDatabaseUrl!,
      })
    : config.bookingDatabaseUrl
      ? createPgPublicHotelProfileRepository({
          connectionString: config.bookingDatabaseUrl,
          bookingHostBase: config.bookingHostBase,
        })
      : undefined;

const bookingSettingsRepository =
  config.bookingSettingsSource === "target"
    ? createPgTargetBookingSettingsRepository({
        connectionString: config.targetDatabaseUrl!,
      })
    : config.bookingDatabaseUrl
      ? createPgBookingSettingsReadRepository({
          connectionString: config.bookingDatabaseUrl,
        })
      : undefined;

const bookingGuestFormSettingsSync =
  config.pmsApiUrl && config.bookingSettingsSource !== "target"
    ? createHttpPmsGuestFormSettingsSync({
        pmsApiUrl: config.pmsApiUrl,
      })
    : undefined;

const bookingReservationsRepository =
  config.bookingReservationsSource === "target"
    ? (() => {
        if (!config.targetDatabaseUrl) {
          throw new Error(
            "TARGET_DATABASE_URL is required when BOOKING_RESERVATIONS_SOURCE=target",
          );
        }

        return createTargetBookingReservationsReadRepository({
          connectionString: config.targetDatabaseUrl,
        });
      })()
    : config.bookingReservationsReadDatabaseUrl
      ? createCompatibilityPmsBookingReservationsReadRepository({
          connectionString: config.bookingReservationsReadDatabaseUrl,
        })
      : undefined;

const publicHotelQuoteRepository =
  publicHotelProfileRepository && config.publicBookabilitySource === "target"
    ? createTargetPublicHotelQuoteRepository({
        connectionString: config.targetDatabaseUrl!,
        profileRepository: publicHotelProfileRepository,
      })
    : publicHotelProfileRepository
      ? createCompatibilityPublicHotelQuoteRepository({
          profileRepository: publicHotelProfileRepository,
          pmsPublicApiUrl: config.pmsPublicApiUrl,
        })
      : undefined;

const bookingWebCalendarRepository =
  config.publicBookabilitySource === "target"
    ? createTargetBookingWebCalendarRepository({
        connectionString: config.targetDatabaseUrl!,
      })
    : undefined;

const pmsOperationsRepository =
  config.pmsOperationsSource === "target"
    ? createTargetPmsOperationsReadRepository({
        connectionString: config.targetDatabaseUrl!,
      })
    : undefined;

const askModelProvider =
  config.askIntelligence.provider === "openai"
    ? await createOpenAIAskModel(config.askIntelligence)
    : undefined;

const providerWebhookSecrets = {
  stripe: config.providerWebhooks.stripeSecret,
  xendit: config.providerWebhooks.xenditSecret,
  channex: config.providerWebhooks.channexSecret,
};
const hasProviderWebhookSecret = Object.values(providerWebhookSecrets).some(Boolean);

const bookingWebAffiliateRepository =
  config.affiliatePublicSource === "target" && config.targetDatabaseUrl
    ? createPgBookingWebAffiliateRepository({
        connectionString: config.targetDatabaseUrl,
      })
    : undefined;

const bookingWebAffiliateHotelResolver =
  config.affiliatePublicSource === "target" && config.targetDatabaseUrl
    ? createPgBookingWebAffiliateHotelResolver({
        connectionString: config.targetDatabaseUrl,
      })
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
  providerWebhooks:
    config.targetDatabaseUrl && hasProviderWebhookSecret
      ? {
          secrets: providerWebhookSecrets,
          modes: {
            stripe: config.providerWebhooks.stripeMode,
            xendit: config.providerWebhooks.xenditMode,
            channex: config.providerWebhooks.channexMode,
          },
          store: createPgProviderWebhookStore({
            connectionString: config.targetDatabaseUrl,
          }),
        }
      : undefined,
  bookingReservationsRepository,
  pmsOperationsRepository,
  pmsOperationsAllowedOrigins: config.pmsOperationsAllowedOrigins,
  bookingSettingsRepository,
  bookingSettingsWriteRepository: bookingSettingsRepository,
  bookingGuestFormSettingsSync,
  marketplaceDiscoveryRepository:
    config.marketplaceDiscoverySource === "target"
      ? createPgMarketplaceDiscoveryReadRepository({
          connectionString: config.targetDatabaseUrl!,
        })
      : undefined,
  marketplaceDiscoveryAllowedOrigins: config.marketplaceDiscoveryAllowedOrigins,
  publicHotelProfileRepository,
  publicHotelQuoteRepository,
  bookingPublicApiUrl: config.bookingPublicApiUrl,
  bookingDomainResolutionSource: config.bookingDomainResolutionSource,
  pmsPublicApiUrl: config.pmsPublicApiUrl,
  bookingWebCalendarRepository,
  askModel: askModelProvider?.model,
  askModelMetadata: askModelProvider?.metadata,
  legacyCheckoutCommandProxyEnabled: config.bookingWebLegacyCheckoutCommandProxyEnabled,
  bookingWebAttributionSink: config.auth
    ? createPgBookingWebEventSink({
        connectionString: config.auth.databaseUrl,
      })
    : undefined,
  bookingWebAffiliateHotelResolver,
  bookingWebAffiliateRepository,
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
