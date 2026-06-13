import { backendAuthPlugin, type BackendAuthPluginOptions } from "@vayada/backend-auth";
import type { IdentityLifecycleCommandBus } from "@vayada/backend-auth";
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
import { registerBookingRoutes } from "./routes/booking.js";
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
import { registerPmsOperationsRoutes } from "./routes/pmsOperations.js";

export type ApiAuthOptions = Omit<BackendAuthPluginOptions, "authorizationResolver"> & {
  rolePermissionRepository: RolePermissionRepository;
  entitlementRepository?: EntitlementRepository;
};

type BuildAppOptions = Pick<FastifyServerOptions, "logger"> & {
  auth?: ApiAuthOptions;
  authSession?: AuthSessionRouteOptions;
  workosWebhooks?: WorkosWebhookRoutesOptions;
  providerWebhooks?: ProviderWebhookRoutesOptions;
  bookingReservationsRepository?: BookingReservationsReadRepository;
  pmsOperationsRepository?: PmsOperationsReadRepository;
  pmsCheckoutChargeMarkPaidFreezeEnabled?: boolean;
  pmsOperationsCommandRepository?: PmsOperationsCommandRepository;
  pmsOperationsAllowedOrigins?: string[];
  bookingSettingsRepository?: BookingSettingsReadRepository;
  bookingSettingsWriteRepository?: BookingSettingsWriteRepository;
  bookingGuestFormSettingsSync?: BookingGuestFormSettingsSync;
  publicHotelProfileRepository?: PublicHotelProfileRepository;
  publicHotelQuoteRepository?: PublicHotelQuoteRepository;
  marketplaceDiscoveryRepository?: MarketplaceDiscoveryReadRepository;
  marketplaceCollaborationRepository?: MarketplaceCollaborationReadRepository;
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
    reservationsRepository: options.bookingReservationsRepository,
    settingsRepository: options.bookingSettingsRepository,
    settingsWriteRepository: options.bookingSettingsWriteRepository,
    guestFormSettingsSync: options.bookingGuestFormSettingsSync,
  });
  if (options.pmsOperationsRepository) {
    app.register(registerPmsOperationsRoutes, {
      prefix: "/api/pms",
      repository: options.pmsOperationsRepository,
      checkoutChargeMarkPaidFreezeEnabled: options.pmsCheckoutChargeMarkPaidFreezeEnabled,
      commandRepository: options.pmsOperationsCommandRepository,
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
  if (options.platformMedia) {
    app.register(registerPlatformMediaRoutes, {
      prefix: "/api/media",
      ...options.platformMedia,
    });
  }

  return app;
}
