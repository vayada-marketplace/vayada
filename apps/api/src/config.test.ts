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
        AUTH_LOGOUT_URL: "https://admin.localhost/login",
        AUTH_ALLOWED_ORIGINS: "https://admin.localhost, https://api.localhost",
        AUTH_COOKIE_SECURE: "false",
        AUTH_COOKIE_DOMAIN: "localhost",
      }).authSession,
    ).toEqual({
      workosClientId: "client",
      workosApiKey: "sk_test",
      authCookieSecret: "cookie-secret",
      authCallbackUrl: "https://api.localhost/auth/workos/callback",
      authLogoutUrl: "https://admin.localhost/login",
      authAllowedOrigins: ["https://admin.localhost", "https://api.localhost"],
      authCookieSecure: false,
      authCookieDomain: "localhost",
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

  it("loads optional booking reservations read database config", () => {
    expect(
      loadConfig({
        BOOKING_RESERVATIONS_READ_DATABASE_URL: "postgresql://booking-reservations-read",
      }).bookingReservationsReadDatabaseUrl,
    ).toBe("postgresql://booking-reservations-read");
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
