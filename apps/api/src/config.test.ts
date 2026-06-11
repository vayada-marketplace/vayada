import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("api config", () => {
  it("keeps auth disabled when auth env values are absent", () => {
    expect(loadConfig({}).auth).toBeUndefined();
  });

  it("loads auth config when all auth env values are present", () => {
    expect(
      loadConfig({
        AUTH_DATABASE_URL: "postgresql://auth-db",
        WORKOS_JWKS_URL: "https://api.workos.com/sso/jwks/client",
        WORKOS_ISSUER: "https://api.workos.com",
        WORKOS_AUDIENCE: "client",
      }).auth,
    ).toEqual({
      databaseUrl: "postgresql://auth-db",
      workosJwksUrl: "https://api.workos.com/sso/jwks/client",
      workosIssuer: "https://api.workos.com",
      workosAudience: "client",
    });
  });

  it("rejects partial auth config", () => {
    expect(() =>
      loadConfig({
        AUTH_DATABASE_URL: "postgresql://auth-db",
      }),
    ).toThrow("Incomplete auth config");
  });

  it("loads AuthKit session route config when all session env values are present", () => {
    expect(
      loadConfig({
        WORKOS_CLIENT_ID: "client",
        WORKOS_API_KEY: "sk_test",
        AUTH_COOKIE_SECRET: "cookie-secret",
        AUTH_CALLBACK_URL: "https://api.localhost/auth/workos/callback",
        AUTH_SUCCESS_URL: "https://admin.localhost/dashboard",
        AUTH_LOGOUT_URL: "https://admin.localhost/login",
        AUTH_ALLOWED_ORIGINS: "https://admin.localhost, https://api.localhost",
        AUTH_COOKIE_SECURE: "false",
        AUTH_COOKIE_DOMAIN: "localhost",
        AUTH_LEGACY_MARKETPLACE_JWT_SECRET: "legacy-secret",
      }).authSession,
    ).toEqual({
      workosClientId: "client",
      workosApiKey: "sk_test",
      authCookieSecret: "cookie-secret",
      authCallbackUrl: "https://api.localhost/auth/workos/callback",
      authSuccessUrl: "https://admin.localhost/dashboard",
      authLogoutUrl: "https://admin.localhost/login",
      authAllowedOrigins: ["https://admin.localhost", "https://api.localhost"],
      authCookieSecure: false,
      authCookieDomain: "localhost",
      authLegacyMarketplaceJwtSecret: "legacy-secret",
    });
  });

  it("rejects partial AuthKit session route config", () => {
    expect(() =>
      loadConfig({
        WORKOS_CLIENT_ID: "client",
      }),
    ).toThrow("Incomplete auth session config");
  });

  it("loads optional booking database config", () => {
    expect(
      loadConfig({
        BOOKING_DATABASE_URL: "postgresql://booking-db",
      }).bookingDatabaseUrl,
    ).toBe("postgresql://booking-db");
  });

  it("loads target public hotel profile and domain resolution config without the legacy booking DB", () => {
    expect(
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
        PUBLIC_HOTEL_PROFILE_SOURCE: "target",
        BOOKING_DOMAIN_RESOLUTION_SOURCE: "target",
      }),
    ).toMatchObject({
      bookingDatabaseUrl: undefined,
      targetDatabaseUrl: "postgresql://target-db",
      publicHotelProfileSource: "target",
      bookingDomainResolutionSource: "target",
    });
  });

  it("rejects target public hotel profile config without the target DB", () => {
    expect(() =>
      loadConfig({
        PUBLIC_HOTEL_PROFILE_SOURCE: "target",
      }),
    ).toThrow("PUBLIC_HOTEL_PROFILE_SOURCE=target requires TARGET_DATABASE_URL");
  });

  it("rejects target domain resolution without target public profiles", () => {
    expect(() =>
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
        BOOKING_DOMAIN_RESOLUTION_SOURCE: "target",
      }),
    ).toThrow(
      "BOOKING_DOMAIN_RESOLUTION_SOURCE=target requires PUBLIC_HOTEL_PROFILE_SOURCE=target",
    );
  });

  it("rejects unsupported public profile source config", () => {
    expect(() =>
      loadConfig({
        PUBLIC_HOTEL_PROFILE_SOURCE: "booking",
      }),
    ).toThrow("PUBLIC_HOTEL_PROFILE_SOURCE must be one of: legacy, target");
  });

  it("loads optional target database config", () => {
    expect(
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
      }).targetDatabaseUrl,
    ).toBe("postgresql://target-db");
  });

  it("keeps booking settings on the legacy source by default", () => {
    expect(loadConfig({}).bookingSettingsSource).toBe("legacy");
  });

  it("loads optional booking settings source config", () => {
    expect(
      loadConfig({
        BOOKING_SETTINGS_SOURCE: "target",
        TARGET_DATABASE_URL: "postgresql://target-db",
      }).bookingSettingsSource,
    ).toBe("target");
  });

  it("requires target database config when booking settings use the target source", () => {
    expect(() =>
      loadConfig({
        BOOKING_SETTINGS_SOURCE: "target",
      }),
    ).toThrow("TARGET_DATABASE_URL is required when BOOKING_SETTINGS_SOURCE=target");
  });

  it("rejects invalid booking settings source config", () => {
    expect(() =>
      loadConfig({
        BOOKING_SETTINGS_SOURCE: "preview",
      }),
    ).toThrow("BOOKING_SETTINGS_SOURCE must be one of: legacy, target");
  });

  it("loads optional booking reservations read database config", () => {
    expect(
      loadConfig({
        BOOKING_RESERVATIONS_READ_DATABASE_URL: "postgresql://booking-reservations-read",
      }).bookingReservationsReadDatabaseUrl,
    ).toBe("postgresql://booking-reservations-read");
  });

  it("defaults booking reservations to the legacy source", () => {
    expect(loadConfig({}).bookingReservationsSource).toBe("legacy");
  });

  it("loads target booking reservations config", () => {
    const config = loadConfig({
      TARGET_DATABASE_URL: "postgresql://target-db",
      BOOKING_RESERVATIONS_SOURCE: "target",
    });

    expect(config.targetDatabaseUrl).toBe("postgresql://target-db");
    expect(config.bookingReservationsSource).toBe("target");
  });

  it("rejects unsupported booking reservations source config", () => {
    expect(() =>
      loadConfig({
        BOOKING_RESERVATIONS_SOURCE: "pms",
      }),
    ).toThrow("BOOKING_RESERVATIONS_SOURCE must be one of: legacy, target");
  });

  it("loads optional booking public API config", () => {
    expect(
      loadConfig({
        BOOKING_PUBLIC_API_URL: "https://api.booking.localhost",
      }).bookingPublicApiUrl,
    ).toBe("https://api.booking.localhost");
  });

  it("loads optional marketplace discovery database config", () => {
    expect(
      loadConfig({
        MARKETPLACE_DATABASE_URL: "postgresql://marketplace-db",
      }).marketplaceDatabaseUrl,
    ).toBe("postgresql://marketplace-db");
  });

  it("loads marketplace discovery allowed origins from comma-separated config", () => {
    expect(
      loadConfig({
        MARKETPLACE_DISCOVERY_ALLOWED_ORIGINS:
          "https://marketplace.localhost, https://admin.localhost,",
      }).marketplaceDiscoveryAllowedOrigins,
    ).toEqual(["https://marketplace.localhost", "https://admin.localhost"]);
  });

  it("loads optional PMS public API config", () => {
    expect(
      loadConfig({
        PMS_PUBLIC_API_URL: "https://api.pms.localhost",
      }).pmsPublicApiUrl,
    ).toBe("https://api.pms.localhost");
  });

  it("defaults public bookability to the legacy source", () => {
    expect(loadConfig({}).publicBookabilitySource).toBe("legacy");
  });

  it("loads target public bookability config", () => {
    const config = loadConfig({
      TARGET_DATABASE_URL: "postgresql://target-db",
      PUBLIC_HOTEL_PROFILE_SOURCE: "target",
      PUBLIC_BOOKABILITY_SOURCE: "target",
    });

    expect(config.targetDatabaseUrl).toBe("postgresql://target-db");
    expect(config.publicBookabilitySource).toBe("target");
  });

  it("requires target database config for target public bookability", () => {
    expect(() =>
      loadConfig({
        PUBLIC_BOOKABILITY_SOURCE: "target",
      }),
    ).toThrow("PUBLIC_BOOKABILITY_SOURCE=target requires TARGET_DATABASE_URL");
  });

  it("requires target public profiles for target public bookability", () => {
    expect(() =>
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
        PUBLIC_BOOKABILITY_SOURCE: "target",
      }),
    ).toThrow("PUBLIC_BOOKABILITY_SOURCE=target requires PUBLIC_HOTEL_PROFILE_SOURCE=target");
  });

  it("rejects unsupported public bookability source config", () => {
    expect(() =>
      loadConfig({
        PUBLIC_BOOKABILITY_SOURCE: "preview",
      }),
    ).toThrow("PUBLIC_BOOKABILITY_SOURCE must be one of: legacy, target");
  });

  it("keeps Booking Web legacy command proxy disabled by default", () => {
    expect(loadConfig({}).bookingWebLegacyCheckoutCommandProxyEnabled).toBe(false);
  });

  it("loads optional Booking Web legacy command proxy config", () => {
    expect(
      loadConfig({
        BOOKING_WEB_LEGACY_CHECKOUT_COMMAND_PROXY_ENABLED: "true",
      }).bookingWebLegacyCheckoutCommandProxyEnabled,
    ).toBe(true);
  });

  it("rejects invalid Booking Web legacy command proxy config", () => {
    expect(() =>
      loadConfig({
        BOOKING_WEB_LEGACY_CHECKOUT_COMMAND_PROXY_ENABLED: "sometimes",
      }),
    ).toThrow("BOOKING_WEB_LEGACY_CHECKOUT_COMMAND_PROXY_ENABLED must be true or false");
  });

  it("loads optional PMS admin API config", () => {
    expect(
      loadConfig({
        PMS_API_URL: "https://api.pms.localhost",
      }).pmsApiUrl,
    ).toBe("https://api.pms.localhost");
  });

  it("loads optional booking host base config", () => {
    expect(
      loadConfig({
        BOOKING_HOST_BASE: "booking.localhost",
      }).bookingHostBase,
    ).toBe("booking.localhost");
  });

  it("keeps Ask Intelligence on the fixture provider by default", () => {
    expect(loadConfig({}).askIntelligence).toEqual({ provider: "fixture" });
    expect(
      loadConfig({
        ASK_INTELLIGENCE_MODEL: "gpt-5.4-mini",
        OPENAI_API_KEY: "sk_test",
      }).askIntelligence,
    ).toEqual({ provider: "fixture" });
  });

  it("loads Ask Intelligence OpenAI provider config only when explicitly enabled", () => {
    expect(
      loadConfig({
        ASK_INTELLIGENCE_PROVIDER: "openai",
        ASK_INTELLIGENCE_MODEL: "gpt-5.4-mini",
        OPENAI_API_KEY: "sk_test",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        OPENAI_ORGANIZATION: "org_test",
        OPENAI_PROJECT: "proj_test",
      }).askIntelligence,
    ).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
      apiKey: "sk_test",
      baseUrl: "https://api.openai.com/v1",
      organization: "org_test",
      project: "proj_test",
    });
  });

  it("rejects incomplete or unsupported Ask Intelligence provider config", () => {
    expect(() =>
      loadConfig({
        ASK_INTELLIGENCE_PROVIDER: "openai",
        ASK_INTELLIGENCE_MODEL: "gpt-5.4-mini",
      }),
    ).toThrow("Incomplete Ask Intelligence OpenAI config");
    expect(() =>
      loadConfig({
        ASK_INTELLIGENCE_PROVIDER: "anthropic",
      }),
    ).toThrow("Unsupported Ask Intelligence provider");
  });
});
