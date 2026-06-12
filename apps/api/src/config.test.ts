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

  it("loads target-owned affiliate public route config", () => {
    expect(
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
        AFFILIATE_PUBLIC_SOURCE: "target",
      }),
    ).toMatchObject({
      targetDatabaseUrl: "postgresql://target-db",
      affiliatePublicSource: "target",
    });
  });

  it("requires a target database for target-owned affiliate public routes", () => {
    expect(() =>
      loadConfig({
        AFFILIATE_PUBLIC_SOURCE: "target",
      }),
    ).toThrow("AFFILIATE_PUBLIC_SOURCE=target requires TARGET_DATABASE_URL");
  });

  it("rejects unsupported affiliate public route sources", () => {
    expect(() =>
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
        AFFILIATE_PUBLIC_SOURCE: "pms",
      }),
    ).toThrow("Unsupported AFFILIATE_PUBLIC_SOURCE");
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
});
