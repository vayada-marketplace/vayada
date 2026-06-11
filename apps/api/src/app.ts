import { backendAuthPlugin, type BackendAuthPluginOptions } from "@vayada/backend-auth";
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
import { registerRouteGroups } from "./routes/groups.js";
import { registerHealthRoutes } from "./routes/health.js";
import {
  registerMarketplaceDiscoveryRoutes,
  type MarketplaceDiscoveryReadRepository,
} from "./routes/marketplaceDiscovery.js";
import {
  registerBookingWebPublicRoutes,
  type BookingWebAttributionSink,
  type BookingWebCheckoutAdapter,
  type BookingWebPublicRoutesOptions,
  type BookingDomainResolutionSource,
} from "./routes/bookingWebPublic.js";

export type ApiAuthOptions = Omit<BackendAuthPluginOptions, "authorizationResolver"> & {
  rolePermissionRepository: RolePermissionRepository;
  entitlementRepository?: EntitlementRepository;
};

type BuildAppOptions = Pick<FastifyServerOptions, "logger"> & {
  auth?: ApiAuthOptions;
  authSession?: AuthSessionRouteOptions;
  workosWebhooks?: WorkosWebhookRoutesOptions;
  bookingReservationsRepository?: BookingReservationsReadRepository;
  bookingSettingsRepository?: BookingSettingsReadRepository;
  bookingSettingsWriteRepository?: BookingSettingsWriteRepository;
  bookingGuestFormSettingsSync?: BookingGuestFormSettingsSync;
  publicHotelProfileRepository?: PublicHotelProfileRepository;
  publicHotelQuoteRepository?: PublicHotelQuoteRepository;
  marketplaceDiscoveryRepository?: MarketplaceDiscoveryReadRepository;
  askAuditRepository?: AskAuditRepository;
  askRuntime?: AskRoutesOptions["runtime"];
  askEvidenceRepository?: AskRoutesOptions["evidenceRepository"];
  askModel?: AskRoutesOptions["model"];
  askModelMetadata?: AskRoutesOptions["modelMetadata"];
  askBudgets?: AskRoutesOptions["budgets"];
  askNow?: AskRoutesOptions["now"];
  marketplaceDiscoveryAllowedOrigins?: string[];
  bookingPublicApiUrl?: string;
  bookingDomainResolutionSource?: BookingDomainResolutionSource;
  pmsPublicApiUrl?: string;
  legacyCheckoutCommandProxyEnabled?: boolean;
  bookingWebCheckoutAdapter?: BookingWebCheckoutAdapter;
  bookingWebAttributionSink?: BookingWebAttributionSink;
  bookingWebPublicFetch?: BookingWebPublicRoutesOptions["fetch"];
  bookingWebPublicNow?: BookingWebPublicRoutesOptions["now"];
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
      legacyCheckoutCommandProxyEnabled: options.legacyCheckoutCommandProxyEnabled,
      checkoutAdapter: options.bookingWebCheckoutAdapter,
      attributionSink: options.bookingWebAttributionSink,
      fetch: options.bookingWebPublicFetch,
      now: options.bookingWebPublicNow,
    });
  }
  if (options.marketplaceDiscoveryRepository) {
    app.register(registerMarketplaceDiscoveryRoutes, {
      prefix: "/api/marketplace",
      repository: options.marketplaceDiscoveryRepository,
      allowedOrigins: options.marketplaceDiscoveryAllowedOrigins,
    });
  }
  app.register(registerBookingRoutes, {
    prefix: "/api/booking",
    reservationsRepository: options.bookingReservationsRepository,
    settingsRepository: options.bookingSettingsRepository,
    settingsWriteRepository: options.bookingSettingsWriteRepository,
    guestFormSettingsSync: options.bookingGuestFormSettingsSync,
  });

  return app;
}
