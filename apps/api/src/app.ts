import { backendAuthPlugin, type BackendAuthPluginOptions } from "@vayada/backend-auth";
import type { IdentityLifecycleCommandBus } from "@vayada/backend-auth";
import type { BookingGuestPiiPort } from "@vayada/domain-booking";
import {
  createAuthorizationResolver,
  type EntitlementRepository,
  type RolePermissionRepository,
} from "@vayada/backend-authorization";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import type { PublicHotelProfileRepository } from "./routes/aiHotels.js";
import type { PublicHotelQuoteRepository } from "./routes/aiHotelQuotes.js";
import type { AskAuditRepository, AskRoutesOptions } from "./routes/ask.js";
import type { BookingReservationsReadRepository } from "./routes/bookingReservations.js";
import type {
  PmsOperationsCommandRepository,
  PmsOperationsReadRepository,
} from "./routes/pmsOperations.js";
import type { AuthSessionRouteOptions } from "./routes/authSession.js";
import type {
  BookingGuestFormSettingsSync,
  BookingSettingsReadRepository,
  BookingSettingsWriteRepository,
} from "./routes/bookingSettings.js";
import { registerAiHotelQuoteRoutes } from "./routes/aiHotelQuotes.js";
import { registerAiHotelRoutes } from "./routes/aiHotels.js";
import { registerAskRoutes } from "./routes/ask.js";
import { registerAuthSessionRoutes } from "./routes/authSession.js";
import {
  registerBookingAdminCompatRoutes,
  type BookingAdminCompatRoutesOptions,
} from "./routes/bookingAdminCompat.js";
import { registerBookingRoutes, type BookingRoutesOptions } from "./routes/booking.js";
import {
  registerWorkosWebhookRoutes,
  type WorkosWebhookRoutesOptions,
} from "./routes/workosWebhooks.js";
import {
  registerProviderWebhookRoutes,
  type ProviderWebhookRoutesOptions,
} from "./routes/providerWebhooks.js";
import { registerRouteGroups } from "./routes/groups.js";
import { registerHealthRoutes } from "./routes/health.js";
import {
  registerMarketplaceDiscoveryRoutes,
  type MarketplaceDiscoveryReadRepository,
} from "./routes/marketplaceDiscovery.js";
import {
  registerMarketplaceCollaborationRoutes,
  type MarketplaceCollaborationReadRepository,
} from "./routes/marketplaceCollaborations.js";
import {
  registerMarketplaceTripRoutes,
  type MarketplaceTripReadRepository,
} from "./routes/marketplaceTrips.js";
import {
  registerMarketplaceAdminRoutes,
  type MarketplaceAdminRepository,
  type MarketplaceAdminRoutesOptions,
} from "./routes/marketplaceAdmin.js";
import {
  registerMarketplaceHotelProfileStatusRoutes,
  type MarketplaceHotelProfileStatusRepository,
} from "./routes/marketplaceHotelProfileStatus.js";
import {
  registerIdentityAdminUserRoutes,
  type IdentityAdminUsersReadRepository,
  type IdentityAdminUserRoutesOptions,
} from "./routes/identityAdminUsers.js";
import {
  registerIdentityPrivacyRoutes,
  type IdentityPrivacyRepository,
} from "./routes/identityPrivacy.js";
import {
  registerBookingWebPublicRoutes,
  type BookingWebAttributionSink,
  type BookingWebCalendarRepository,
  type BookingWebCheckoutAdapter,
  type BookingWebPublicRoutesOptions,
  type BookingDomainResolutionSource,
} from "./routes/bookingWebPublic.js";
import {
  registerBookingWebAffiliateRoutes,
  type BookingWebAffiliateHotelResolver,
  type BookingWebAffiliateRepository,
} from "./routes/bookingWebAffiliate.js";
import {
  registerFinanceRoutes,
  type FinancePublicHotelPropertyResolver,
  type FinanceRoutesOptions,
  type FinanceXenditBankValidator,
} from "./routes/finance.js";
import {
  registerPlatformMediaRoutes,
  type PlatformMediaRoutesOptions,
} from "./routes/platformMedia.js";
import {
  registerPlatformContactIntakeRoutes,
  type PlatformContactIntakeRoutesOptions,
} from "./routes/platformContactIntake.js";
import {
  registerPmsLegacyAdminRoutes,
  registerPmsOperationsRoutes,
} from "./routes/pmsOperations.js";

export type ApiAuthOptions = Omit<BackendAuthPluginOptions, "authorizationResolver"> & {
  rolePermissionRepository: RolePermissionRepository;
  entitlementRepository?: EntitlementRepository;
};

type BuildAppOptions = Pick<FastifyServerOptions, "logger"> & {
  auth?: ApiAuthOptions;
  authSession?: AuthSessionRouteOptions;
  browserAllowedOrigins?: string[];
  workosWebhooks?: WorkosWebhookRoutesOptions;
  providerWebhooks?: ProviderWebhookRoutesOptions;
  bookingReservationsRepository?: BookingReservationsReadRepository;
  pmsOperationsRepository?: PmsOperationsReadRepository;
  pmsCheckoutChargeMarkPaidFreezeEnabled?: boolean;
  pmsOperationsCommandRepository?: PmsOperationsCommandRepository;
  bookingGuestPiiPort?: BookingGuestPiiPort;
  pmsOperationsAllowedOrigins?: string[];
  bookingDashboardMetricsReadPort?: BookingRoutesOptions["dashboardMetricsReadPort"];
  bookingSettingsRepository?: BookingSettingsReadRepository;
  bookingSettingsWriteRepository?: BookingSettingsWriteRepository;
  bookingGuestFormSettingsSync?: BookingGuestFormSettingsSync;
  bookingAdminCompat?: BookingAdminCompatRoutesOptions;
  publicHotelProfileRepository?: PublicHotelProfileRepository;
  publicHotelQuoteRepository?: PublicHotelQuoteRepository;
  marketplaceDiscoveryRepository?: MarketplaceDiscoveryReadRepository;
  marketplaceCollaborationRepository?: MarketplaceCollaborationReadRepository;
  marketplaceTripRepository?: MarketplaceTripReadRepository;
  marketplaceAdminRepository?: MarketplaceAdminRepository;
  marketplaceAdminLegacySuperadminFallbackEnabled?: MarketplaceAdminRoutesOptions["legacySuperadminFallbackEnabled"];
  marketplaceHotelProfileStatusRepository?: MarketplaceHotelProfileStatusRepository;
  identityPrivacyRepository?: IdentityPrivacyRepository;
  identityLifecycleCommandBus?: IdentityLifecycleCommandBus;
  identityAdminUsersReadRepository?: IdentityAdminUsersReadRepository;
  identityAdminUsers?: Omit<
    IdentityAdminUserRoutesOptions,
    "lifecycleCommandBus" | "readRepository"
  >;
  askAuditRepository?: AskAuditRepository;
  askRuntime?: AskRoutesOptions["runtime"];
  askEvidenceRepository?: AskRoutesOptions["evidenceRepository"];
  askModel?: AskRoutesOptions["model"];
  askModelMetadata?: AskRoutesOptions["modelMetadata"];
  askBudgets?: AskRoutesOptions["budgets"];
  askNow?: AskRoutesOptions["now"];
  platformContactIntake?: PlatformContactIntakeRoutesOptions;
  marketplaceDiscoveryAllowedOrigins?: string[];
  identityPrivacyAllowedOrigins?: string[];
  bookingPublicApiUrl?: string;
  bookingDomainResolutionSource?: BookingDomainResolutionSource;
  pmsPublicApiUrl?: string;
  bookingWebCalendarRepository?: BookingWebCalendarRepository;
  legacyCheckoutCommandProxyEnabled?: boolean;
  bookingWebCheckoutAdapter?: BookingWebCheckoutAdapter;
  bookingWebAffiliateHotelResolver?: BookingWebAffiliateHotelResolver;
  bookingWebAffiliateRepository?: BookingWebAffiliateRepository;
  bookingWebAttributionSink?: BookingWebAttributionSink;
  bookingWebPublicFetch?: BookingWebPublicRoutesOptions["fetch"];
  bookingWebPublicNow?: BookingWebPublicRoutesOptions["now"];
  financeRepository?: FinanceRoutesOptions["repository"];
  financeXenditBankValidator?: FinanceXenditBankValidator;
  financePublicHotelProfileRepository?: PublicHotelProfileRepository;
  financePublicHotelPropertyResolver?: FinancePublicHotelPropertyResolver;
  platformMedia?: PlatformMediaRoutesOptions;
};

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  registerBrowserCors(app, options.browserAllowedOrigins ?? []);

  if (options.auth) {
    const { rolePermissionRepository, entitlementRepository, ...authOptions } = options.auth;
    app.register(backendAuthPlugin, {
      ...authOptions,
      authorizationResolver: createAuthorizationResolver(
        rolePermissionRepository,
        entitlementRepository,
      ),
    });
  }

  app.register(registerHealthRoutes);
  if (options.authSession) {
    app.register(registerAuthSessionRoutes, {
      prefix: "/auth",
      ...options.authSession,
    });
  }
  if (options.workosWebhooks) {
    app.register(registerWorkosWebhookRoutes, {
      prefix: "/auth/workos",
      ...options.workosWebhooks,
    });
  }
  if (options.providerWebhooks) {
    app.register(registerProviderWebhookRoutes, options.providerWebhooks);
  }
  app.register(registerRouteGroups, { prefix: "/api" });
  app.register(registerAskRoutes, {
    prefix: "/api/ai",
    auditRepository: options.askAuditRepository,
    runtime: options.askRuntime,
    evidenceRepository: options.askEvidenceRepository,
    model: options.askModel,
    modelMetadata: options.askModelMetadata,
    budgets: options.askBudgets,
    now: options.askNow,
  });
  if (options.publicHotelProfileRepository) {
    app.register(registerAiHotelRoutes, {
      prefix: "/api/ai",
      repository: options.publicHotelProfileRepository,
    });
  }
  if (options.publicHotelQuoteRepository) {
    app.register(registerAiHotelQuoteRoutes, {
      prefix: "/api/ai",
      repository: options.publicHotelQuoteRepository,
    });
  }
  if (options.publicHotelProfileRepository) {
    app.register(registerBookingWebPublicRoutes, {
      prefix: "/api/booking-web",
      profileRepository: options.publicHotelProfileRepository,
      quoteRepository: options.publicHotelQuoteRepository,
      bookingPublicApiUrl: options.bookingPublicApiUrl,
      bookingDomainResolutionSource: options.bookingDomainResolutionSource,
      pmsPublicApiUrl: options.pmsPublicApiUrl,
      calendarRepository: options.bookingWebCalendarRepository,
      legacyCheckoutCommandProxyEnabled: options.legacyCheckoutCommandProxyEnabled,
      checkoutAdapter: options.bookingWebCheckoutAdapter,
      affiliateHotelResolver:
        options.bookingWebAffiliateHotelResolver ?? options.publicHotelProfileRepository,
      affiliateRepository: options.bookingWebAffiliateRepository,
      attributionSink: options.bookingWebAttributionSink,
      fetch: options.bookingWebPublicFetch,
      now: options.bookingWebPublicNow,
    });
  } else if (options.bookingWebAffiliateRepository && options.bookingWebAffiliateHotelResolver) {
    app.register(registerBookingWebAffiliateRoutes, {
      prefix: "/api/booking-web",
      hotelResolver: options.bookingWebAffiliateHotelResolver,
      repository: options.bookingWebAffiliateRepository,
    });
  }
  if (options.marketplaceDiscoveryRepository) {
    app.register(registerMarketplaceDiscoveryRoutes, {
      prefix: "/api/marketplace",
      repository: options.marketplaceDiscoveryRepository,
      allowedOrigins: options.marketplaceDiscoveryAllowedOrigins,
    });
  }
  if (options.marketplaceCollaborationRepository) {
    app.register(registerMarketplaceCollaborationRoutes, {
      prefix: "/api/marketplace",
      repository: options.marketplaceCollaborationRepository,
    });
  }
  if (options.marketplaceTripRepository) {
    app.register(registerMarketplaceTripRoutes, {
      prefix: "/api/marketplace",
      repository: options.marketplaceTripRepository,
    });
  }
  if (options.marketplaceAdminRepository) {
    app.register(registerMarketplaceAdminRoutes, {
      prefix: "/api/marketplace",
      repository: options.marketplaceAdminRepository,
      legacySuperadminFallbackEnabled: options.marketplaceAdminLegacySuperadminFallbackEnabled,
    });
  }
  if (options.marketplaceHotelProfileStatusRepository) {
    app.register(registerMarketplaceHotelProfileStatusRoutes, {
      prefix: "/api/marketplace",
      repository: options.marketplaceHotelProfileStatusRepository,
    });
  }
  if (options.identityPrivacyRepository) {
    app.register(registerIdentityPrivacyRoutes, {
      prefix: "/api/identity",
      repository: options.identityPrivacyRepository,
      allowedOrigins: options.identityPrivacyAllowedOrigins,
    });
  }
  if (options.identityLifecycleCommandBus) {
    app.register(registerIdentityAdminUserRoutes, {
      prefix: "/api/identity/admin",
      lifecycleCommandBus: options.identityLifecycleCommandBus,
      readRepository: options.identityAdminUsersReadRepository,
      ...options.identityAdminUsers,
    });
  }
  app.register(registerBookingRoutes, {
    prefix: "/api/booking",
    dashboardMetricsReadPort: options.bookingDashboardMetricsReadPort,
    reservationsRepository: options.bookingReservationsRepository,
    settingsRepository: options.bookingSettingsRepository,
    settingsWriteRepository: options.bookingSettingsWriteRepository,
    guestFormSettingsSync: options.bookingGuestFormSettingsSync,
  });
  if (options.bookingAdminCompat) {
    app.register(registerBookingAdminCompatRoutes, {
      prefix: "/admin",
      ...options.bookingAdminCompat,
    });
  }
  if (options.pmsOperationsRepository) {
    app.register(registerPmsLegacyAdminRoutes, {
      prefix: "/admin",
      repository: options.pmsOperationsRepository,
      allowedOrigins: options.pmsOperationsAllowedOrigins,
    });
    app.register(registerPmsOperationsRoutes, {
      prefix: "/api/pms",
      repository: options.pmsOperationsRepository,
      checkoutChargeMarkPaidFreezeEnabled: options.pmsCheckoutChargeMarkPaidFreezeEnabled,
      commandRepository: options.pmsOperationsCommandRepository,
      bookingGuestPiiPort: options.bookingGuestPiiPort,
      allowedOrigins: options.pmsOperationsAllowedOrigins,
    });
  }
  if (options.financeRepository) {
    const financePublicHotelProfileRepository =
      options.financePublicHotelProfileRepository ?? options.publicHotelProfileRepository;
    app.register(registerFinanceRoutes, {
      prefix: "/api",
      repository: options.financeRepository,
      xenditBankValidator: options.financeXenditBankValidator,
      publicHotelPropertyResolver: options.financePublicHotelPropertyResolver,
      publicHotelProfileRepository: financePublicHotelProfileRepository,
      closePublicHotelProfileRepository:
        Boolean(options.financePublicHotelProfileRepository) &&
        options.financePublicHotelProfileRepository !== options.publicHotelProfileRepository,
    });
  }
  if (options.platformContactIntake) {
    app.register(registerPlatformContactIntakeRoutes, {
      prefix: "/api",
      ...options.platformContactIntake,
    });
  }
  if (options.platformMedia) {
    app.register(registerPlatformMediaRoutes, {
      prefix: "/api/media",
      ...options.platformMedia,
    });
  }

  return app;
}

function registerBrowserCors(app: FastifyInstance, allowedOrigins: string[]): void {
  const allowedOriginSet = new Set(allowedOrigins);
  if (allowedOriginSet.size === 0) return;

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin || !allowedOriginSet.has(origin)) return;

    reply
      .header("Vary", "Origin")
      .header("Access-Control-Allow-Origin", origin)
      .header("Access-Control-Allow-Credentials", "true")
      .header(
        "Access-Control-Allow-Headers",
        request.headers["access-control-request-headers"] ??
          "authorization,content-type,x-hotel-id,x-vayada-csrf",
      )
      .header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
      .header("Access-Control-Max-Age", "600");

    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });
}
