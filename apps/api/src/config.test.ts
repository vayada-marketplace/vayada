import { describe, expect, it } from "vitest";

import { loadConfig, stripeSubscriptionRuntimeEnabled } from "./config.js";

const completeCreatorMarketplaceEnv = {
  TARGET_DATABASE_URL: "postgresql://api_runtime@target-db/app",
  AUTH_DATABASE_URL: "postgresql://auth-db",
  WORKOS_JWKS_URL: "https://api.workos.com/sso/jwks/client",
  WORKOS_ISSUER: "https://api.workos.com",
  WORKOS_AUDIENCE: "client",
  PLATFORM_MEDIA_BUCKET: "vayada-media-staging",
  PLATFORM_MEDIA_CDN_BASE_URL: "https://cdn.staging.vayada.com",
  PLATFORM_MEDIA_CDN_ORIGIN_HOST: "vayada-media-staging.s3.us-east-1.amazonaws.com",
};

const completeCreatorPlatformConnectionEnv = {
  ...completeCreatorMarketplaceEnv,
};

const completeAuthSessionEnv = {
  WORKOS_CLIENT_ID: "client",
  WORKOS_API_KEY: "sk_test",
  AUTH_COOKIE_SECRET: "cookie-secret",
  AUTH_LOGOUT_URL: "https://admin.localhost/login",
  AUTH_ALLOWED_ORIGINS:
    "https://admin.localhost, https://api.localhost, https://admin.booking.localhost, " +
    "https://pms.localhost, https://affiliate.localhost, https://marketplace.localhost",
  AUTH_COMPATIBILITY_CALLBACK_ORIGIN: "https://api.localhost",
  AUTH_PLATFORM_ADMIN_ORIGIN: "https://admin.localhost",
  AUTH_BOOKING_ADMIN_ORIGIN: "https://admin.booking.localhost",
  AUTH_PMS_WEB_ORIGIN: "https://pms.localhost",
  AUTH_AFFILIATE_DASHBOARD_ORIGIN: "https://affiliate.localhost",
  AUTH_MARKETPLACE_WEB_ORIGIN: "https://marketplace.localhost",
};

const financeFolioKmsEnv = {
  FINANCE_FOLIO_RECIPIENT_KMS_CURRENT_KEY_ARN:
    "arn:aws:kms:eu-west-1:123456789012:key/11111111-2222-3333-4444-555555555555",
  FINANCE_FOLIO_RECIPIENT_KMS_ALLOWED_KEY_ARNS:
    "arn:aws:kms:eu-west-1:123456789012:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee,arn:aws:kms:eu-west-1:123456789012:key/11111111-2222-3333-4444-555555555555",
  FINANCE_FOLIO_RECIPIENT_KMS_FINGERPRINT_KEY_ARN:
    "arn:aws:kms:eu-west-1:123456789012:key/99999999-8888-7777-6666-555555555555",
};

describe("api config", () => {
  it("keeps Financials activation closed without a scoped property allowlist", () => {
    expect(loadConfig({}).financialsActivationPropertyIds).toEqual([]);
    expect(
      loadConfig({
        PMS_FINANCIALS_ACTIVATION_PROPERTY_IDS:
          "11111111-1111-4111-8111-111111111111,11111111-1111-4111-8111-111111111111",
      }).financialsActivationPropertyIds,
    ).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(() => loadConfig({ PMS_FINANCIALS_ACTIVATION_PROPERTY_IDS: "not-a-property" })).toThrow(
      "PMS_FINANCIALS_ACTIVATION_PROPERTY_IDS",
    );
  });

  it("does not reuse the general or auth database URL for pricing authority", () => {
    const base = loadConfig(completeCreatorMarketplaceEnv);
    expect(base.pricingDatabaseUrl).toBeUndefined();
    expect(
      loadConfig({
        ...completeCreatorMarketplaceEnv,
        PRICING_DATABASE_URL: "postgresql://pricing_runtime@pricing-db",
      }).pricingDatabaseUrl,
    ).toBe("postgresql://pricing_runtime@pricing-db");
    expect(() =>
      loadConfig({
        ...completeCreatorMarketplaceEnv,
        PRICING_DATABASE_URL: completeCreatorMarketplaceEnv.TARGET_DATABASE_URL,
      }),
    ).toThrow("PRICING_DATABASE_URL must use a distinct PostgreSQL user");
    expect(() =>
      loadConfig({
        ...completeCreatorMarketplaceEnv,
        PRICING_DATABASE_URL: completeCreatorMarketplaceEnv.AUTH_DATABASE_URL,
      }),
    ).toThrow("PRICING_DATABASE_URL must use a distinct PostgreSQL user");
    expect(() =>
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://general_runtime@target-db/vayada",
        PRICING_DATABASE_URL:
          "postgresql://general_runtime@target-db/vayada?application_name=pricing",
      }),
    ).toThrow("PRICING_DATABASE_URL must use a distinct PostgreSQL user");
    expect(() =>
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://general_runtime@target-db/vayada",
        PRICING_DATABASE_URL: "postgresql://pricing_runtime@target-db/vayada?user=general_runtime",
      }),
    ).toThrow("PRICING_DATABASE_URL must use a distinct PostgreSQL user");
  });

  it("loads complete Marketplace unsubscribe rotation keys and rejects partial config", () => {
    const keys = {
      "key-1": Buffer.alloc(32, 1).toString("base64url"),
      "key-2": Buffer.alloc(32, 2).toString("base64url"),
    };
    const config = (current = "key-2", encoded = JSON.stringify(keys)) =>
      loadConfig({
        MARKETPLACE_COMMUNICATION_UNSUBSCRIBE_CURRENT_KEY_VERSION: current,
        MARKETPLACE_COMMUNICATION_UNSUBSCRIBE_KEYS_JSON: encoded,
      });
    expect(config().marketplaceCommunicationUnsubscribe).toEqual({
      currentKeyVersion: "key-2",
      keys,
    });
    expect(() =>
      loadConfig({ MARKETPLACE_COMMUNICATION_UNSUBSCRIBE_CURRENT_KEY_VERSION: "key-2" }),
    ).toThrow("Incomplete Marketplace communication unsubscribe signing config");
    expect(() => config("missing")).toThrow("signing keys are invalid");
    expect(() => config("key-2", "not-json")).toThrow("must be valid JSON");
  });

  it("parses a review-only webhook override without changing other intake modes", () => {
    expect(loadConfig({}).providerWebhooks.channexReviewMode).toBeUndefined();
    const config = loadConfig({ CHANNEX_REVIEW_WEBHOOK_INTAKE_MODE: "mutating" });
    expect(config.providerWebhooks.channexReviewMode).toBe("mutating");
    expect(config.providerWebhooks.channexMode).toBe("observe_only");
    expect(() => loadConfig({ CHANNEX_REVIEW_WEBHOOK_INTAKE_MODE: "invalid" })).toThrow(
      "CHANNEX_REVIEW_WEBHOOK_INTAKE_MODE",
    );
  });

  it("parses the Inbox-only sending control without changing Channex or Booking email", () => {
    expect(loadConfig({}).pmsInboxSendingEnabled).toBe(true);
    expect(loadConfig({ PMS_INBOX_SENDING_ENABLED: "true" }).pmsInboxSendingEnabled).toBe(true);
    const email = { RESEND_API_KEY: "test-key", BOOKING_EMAIL_FROM: "sender@example.test" };
    const paused = loadConfig({ ...email, PMS_INBOX_SENDING_ENABLED: "false" });
    expect(paused.pmsInboxSendingEnabled).toBe(false);
    expect(paused.bookingEmailDelivery).toEqual(loadConfig(email).bookingEmailDelivery);
    expect(paused.bookingEmailDelivery).toBeDefined();
    expect(paused.channexManagement).toEqual(loadConfig(email).channexManagement);
    expect(() => loadConfig({ PMS_INBOX_SENDING_ENABLED: "flase" })).toThrow(
      "PMS_INBOX_SENDING_ENABLED",
    );
  });

  it("keeps Channex management fail-closed until each capability is cut over", () => {
    expect(loadConfig({}).channexManagement).toMatchObject({
      bookingMutationOwner: "legacy",
      workerEnabled: false,
      capabilityModes: {
        connection: "observe_only",
        provisioning: "observe_only",
        ariSync: "observe_only",
        bookingSync: "observe_only",
        markups: "observe_only",
        messaging: "observe_only",
        reviews: "observe_only",
        iframe: "observe_only",
      },
    });
  });

  it("loads explicitly cut-over Channex capabilities only with target provider config", () => {
    const config = loadConfig({
      TARGET_DATABASE_URL: "postgresql://api_runtime@target-db/app",
      PMS_OPERATIONS_SOURCE: "target",
      CHANNEX_API_BASE_URL: "https://staging.channex.io",
      CHANNEX_API_KEY: "secret",
      PMS_CHANNEX_CONNECTION_MODE: "mutating",
      PMS_CHANNEX_WORKER_ENABLED: "true",
      PMS_CHANNEX_MANAGEMENT_DATABASE_URL: "postgresql://channex_worker@target-db/app",
    });
    expect(config.channexManagement).toMatchObject({
      apiBaseUrl: "https://staging.channex.io",
      workerEnabled: true,
      capabilityModes: { connection: "mutating", provisioning: "observe_only" },
    });
  });

  it("allows only isolated staging restrictions with the background workers disabled", () => {
    const base = {
      TARGET_DATABASE_URL: "postgresql://api_runtime@target-db/app",
      PMS_OPERATIONS_SOURCE: "target",
      CHANNEX_API_BASE_URL: "https://staging.channex.io",
      CHANNEX_API_KEY: "test",
      API_BACKGROUND_WORKERS_ENABLED: "false",
      PMS_CHANNEX_ARI_SYNC_MODE: "mutating",
      PMS_CHANNEX_MANAGEMENT_DATABASE_URL: "postgresql://channex_worker@target-db/app",
      PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: "65f6b2fc-c783-4963-9d6b-a85f82319769",
    };
    expect(loadConfig(base).channexManagement.stagingRestrictionsPropertyId).toBe(
      base.PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID,
    );
    for (const invalid of [
      { CHANNEX_API_BASE_URL: "https://app.channex.io" },
      { PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: "invalid" },
      { API_BACKGROUND_WORKERS_ENABLED: "true" },
      { API_BACKGROUND_WORKERS_ENABLED: undefined },
      { PMS_CHANNEX_ARI_SYNC_MODE: "observe_only" },
      ...["CONNECTION", "PROVISIONING", "BOOKING_SYNC", "MARKUPS", "MESSAGING", "IFRAME"].map(
        (capability) => ({ [`PMS_CHANNEX_${capability}_MODE`]: "mutating" }),
      ),
    ])
      expect(() => loadConfig({ ...base, ...invalid })).toThrow(
        "Scoped Channex restrictions require",
      );
  });

  it("requires explicit opt-in and retains isolation for staged inventory rules", () => {
    const base = {
      TARGET_DATABASE_URL: "postgresql://api_runtime@target-db/app",
      PMS_OPERATIONS_SOURCE: "target",
      CHANNEX_API_BASE_URL: "https://staging.channex.io",
      CHANNEX_API_KEY: "test",
      API_BACKGROUND_WORKERS_ENABLED: "false",
      PMS_CHANNEX_ARI_SYNC_MODE: "mutating",
      PMS_CHANNEX_MANAGEMENT_DATABASE_URL: "postgresql://channex_worker@target-db/app",
      PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: "65f6b2fc-c783-4963-9d6b-a85f82319769",
    };
    expect(loadConfig(base).channexManagement.stagingInventoryEnabled).toBe(false);
    const enabled = { ...base, PMS_CHANNEX_STAGING_INVENTORY_ENABLED: "true" };
    expect(loadConfig(enabled).channexManagement.stagingInventoryEnabled).toBe(true);
    for (const invalid of [
      { PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: undefined },
      { PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: "invalid" },
      { CHANNEX_API_BASE_URL: "https://app.channex.io" },
      { API_BACKGROUND_WORKERS_ENABLED: "true" },
      { PMS_CHANNEX_ARI_SYNC_MODE: "observe_only" },
      { PMS_CHANNEX_BOOKING_SYNC_MODE: "mutating" },
    ])
      expect(() => loadConfig({ ...enabled, ...invalid })).toThrow();
  });

  it("isolates no-show opt-in without enabling booking sync and permits worker pause", () => {
    const base = {
      TARGET_DATABASE_URL: "postgresql://api_runtime@target-db/app",
      PMS_OPERATIONS_SOURCE: "target",
      CHANNEX_API_BASE_URL: "https://staging.channex.io",
      CHANNEX_API_KEY: "test",
      API_BACKGROUND_WORKERS_ENABLED: "false",
      PMS_CHANNEX_ARI_SYNC_MODE: "mutating",
      PMS_CHANNEX_MANAGEMENT_DATABASE_URL: "postgresql://channex_worker@target-db/app",
      PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: "65f6b2fc-c783-4963-9d6b-a85f82319769",
    };
    expect(loadConfig(base).channexManagement.stagingNoShowEnabled).toBe(false);
    const enabled = { ...base, PMS_CHANNEX_STAGING_NO_SHOW_ENABLED: "true" };
    expect(loadConfig(enabled).channexManagement).toMatchObject({
      stagingNoShowEnabled: true,
      capabilityModes: { bookingSync: "observe_only" },
    });
    expect(
      loadConfig({ ...enabled, PMS_CHANNEX_WORKER_ENABLED: "false" }).channexManagement
        .workerEnabled,
    ).toBe(false);
    for (const invalid of [
      { PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: undefined },
      { PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: "invalid" },
      { CHANNEX_API_BASE_URL: "https://app.channex.io" },
      { CHANNEX_API_KEY: undefined },
      { API_BACKGROUND_WORKERS_ENABLED: "true" },
      { PMS_CHANNEX_BOOKING_SYNC_MODE: "mutating" },
      { PMS_CHANNEX_STAGING_NO_SHOW_ENABLED: "invalid" },
    ])
      expect(() => loadConfig({ ...enabled, ...invalid })).toThrow();
  });

  it("requires explicit opt-in and retains isolation for scoped meal processing", () => {
    const base = {
      TARGET_DATABASE_URL: "postgresql://api_runtime@target-db/app",
      PMS_OPERATIONS_SOURCE: "target",
      CHANNEX_API_BASE_URL: "https://staging.channex.io",
      CHANNEX_API_KEY: "test",
      API_BACKGROUND_WORKERS_ENABLED: "false",
      PMS_CHANNEX_ARI_SYNC_MODE: "mutating",
      PMS_CHANNEX_MANAGEMENT_DATABASE_URL: "postgresql://channex_worker@target-db/app",
      PMS_CHANNEX_PROVISIONING_MODE: "mutating",
      PMS_CHANNEX_STAGING_MEALS_ENABLED: "true",
      PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: "65f6b2fc-c783-4963-9d6b-a85f82319769",
    };
    expect(loadConfig(base).channexManagement.stagingMealsEnabled).toBe(true);
    for (const invalid of [
      { PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: undefined },
      { PMS_CHANNEX_STAGING_MEALS_ENABLED: "false" },
      { PMS_CHANNEX_PROVISIONING_MODE: "observe_only" },
      { CHANNEX_API_BASE_URL: "https://app.channex.io" },
      { API_BACKGROUND_WORKERS_ENABLED: "true" },
      ...["CONNECTION", "BOOKING_SYNC", "MARKUPS", "MESSAGING", "IFRAME"].map((capability) => ({
        [`PMS_CHANNEX_${capability}_MODE`]: "mutating",
      })),
    ])
      expect(() => loadConfig({ ...base, ...invalid })).toThrow();
  });

  it("requires explicit opt-in and retains isolation for published offer provisioning", () => {
    const base = {
      TARGET_DATABASE_URL: "postgresql://api_runtime@target-db/app",
      PMS_OPERATIONS_SOURCE: "target",
      CHANNEX_API_BASE_URL: "https://staging.channex.io",
      CHANNEX_API_KEY: "test",
      API_BACKGROUND_WORKERS_ENABLED: "false",
      PMS_CHANNEX_ARI_SYNC_MODE: "mutating",
      PMS_CHANNEX_MANAGEMENT_DATABASE_URL: "postgresql://channex_worker@target-db/app",
      PMS_CHANNEX_PROVISIONING_MODE: "mutating",
      PMS_CHANNEX_STAGING_PUBLISHED_OFFERS_ENABLED: "true",
      PMS_CHANNEX_STAGING_INVENTORY_ENABLED: "true",
      PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: "65f6b2fc-c783-4963-9d6b-a85f82319769",
    };
    expect(loadConfig(base).channexManagement.stagingPublishedOffersEnabled).toBe(true);
    for (const invalid of [
      { PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: undefined },
      { PMS_CHANNEX_STAGING_PUBLISHED_OFFERS_ENABLED: "false" },
      { PMS_CHANNEX_STAGING_INVENTORY_ENABLED: "false" },
      { PMS_CHANNEX_PROVISIONING_MODE: "observe_only" },
      { CHANNEX_API_BASE_URL: "https://app.channex.io" },
      { API_BACKGROUND_WORKERS_ENABLED: "true" },
      { PMS_CHANNEX_BOOKING_SYNC_MODE: "mutating" },
    ])
      expect(() => loadConfig({ ...base, ...invalid })).toThrow();
  });

  it.each([false, true])("loads a paused isolated staging runtime (meals=%s)", (meals) => {
    const environment = {
      TARGET_DATABASE_URL: "postgresql://api_runtime@target-db/app",
      PMS_OPERATIONS_SOURCE: "target",
      CHANNEX_API_BASE_URL: "https://staging.channex.io",
      CHANNEX_API_KEY: "synthetic-test-key",
      API_BACKGROUND_WORKERS_ENABLED: "false",
      PMS_CHANNEX_WORKER_ENABLED: "false",
      PMS_CHANNEX_ARI_SYNC_MODE: "mutating",
      PMS_CHANNEX_STAGING_MEALS_ENABLED: String(meals),
      PMS_CHANNEX_PROVISIONING_MODE: meals ? "mutating" : "observe_only",
      PMS_CHANNEX_CONNECTION_MODE: "observe_only",
      PMS_CHANNEX_BOOKING_SYNC_MODE: "observe_only",
      PMS_CHANNEX_MARKUPS_MODE: "observe_only",
      PMS_CHANNEX_MESSAGING_MODE: "observe_only",
      PMS_CHANNEX_IFRAME_MODE: "observe_only",
      PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: "65f6b2fc-c783-4963-9d6b-a85f82319769",
    };
    const paused = loadConfig(environment);
    expect(paused.backgroundWorkersEnabled).toBe(false);
    expect(paused.channexManagement).toMatchObject({
      workerEnabled: false,
      stagingMealsEnabled: meals,
      capabilityModes: { ariSync: "mutating", provisioning: meals ? "mutating" : "observe_only" },
    });
    const resumed = loadConfig({
      ...environment,
      PMS_CHANNEX_WORKER_ENABLED: "true",
      PMS_CHANNEX_MANAGEMENT_DATABASE_URL: "postgresql://channex_worker@target-db/app",
    });
    expect(resumed).toEqual({
      ...paused,
      channexManagement: {
        ...paused.channexManagement,
        workerEnabled: true,
        workerDatabaseUrl: "postgresql://channex_worker@target-db/app",
      },
    });
    for (const invalid of [
      { PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: undefined },
      { PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: "invalid" },
      { CHANNEX_API_BASE_URL: "https://app.channex.io" },
      { CHANNEX_API_KEY: undefined },
      { API_BACKGROUND_WORKERS_ENABLED: "true" },
      { API_BACKGROUND_WORKERS_ENABLED: undefined },
      { PMS_OPERATIONS_SOURCE: "legacy" },
      { PMS_CHANNEX_BOOKING_SYNC_MODE: "mutating" },
      { PMS_CHANNEX_CONNECTION_MODE: "mutating" },
      { PMS_CHANNEX_MESSAGING_MODE: "mutating" },
      { PMS_CHANNEX_ARI_SYNC_MODE: "observe_only" },
    ]) {
      expect(() => loadConfig({ ...environment, ...invalid })).toThrow();
    }
  });

  it("rejects Channex mutation without provider config or target ownership", () => {
    expect(() => loadConfig({ PMS_CHANNEX_ARI_SYNC_MODE: "mutating" })).toThrow(
      "Mutating PMS Channex capabilities require CHANNEX_API_BASE_URL and CHANNEX_API_KEY",
    );
    expect(() =>
      loadConfig({
        PMS_CHANNEX_ARI_SYNC_MODE: "mutating",
        CHANNEX_API_BASE_URL: "https://staging.channex.io",
        CHANNEX_API_KEY: "secret",
      }),
    ).toThrow("Mutating PMS Channex capabilities require PMS_OPERATIONS_SOURCE=target");
    expect(() =>
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://api_runtime@target-db/app",
        PMS_OPERATIONS_SOURCE: "target",
        PMS_CHANNEX_CONNECTION_MODE: "mutating",
        PMS_CHANNEX_WORKER_ENABLED: "false",
        CHANNEX_API_BASE_URL: "https://staging.channex.io",
        CHANNEX_API_KEY: "secret",
      }),
    ).toThrow("Mutating PMS Channex capabilities require PMS_CHANNEX_WORKER_ENABLED=true");
  });

  it("requires a dedicated management database credential before the worker starts", () => {
    const enabled = {
      TARGET_DATABASE_URL: "postgresql://api_runtime@db/app",
      PMS_OPERATIONS_SOURCE: "target",
      CHANNEX_API_BASE_URL: "https://staging.channex.io",
      CHANNEX_API_KEY: "secret",
      PMS_CHANNEX_CONNECTION_MODE: "mutating",
      PMS_CHANNEX_WORKER_ENABLED: "true",
    };
    expect(() => loadConfig(enabled)).toThrow("PMS_CHANNEX_MANAGEMENT_DATABASE_URL");
    expect(() =>
      loadConfig({
        ...enabled,
        PMS_CHANNEX_MANAGEMENT_DATABASE_URL:
          "postgresql://api_runtime@db/app?application_name=channex",
      }),
    ).toThrow("must use a dedicated credential");
    expect(() =>
      loadConfig({
        ...enabled,
        PMS_CHANNEX_MANAGEMENT_DATABASE_URL: "postgresql://channex_worker@db/app?user=api_runtime",
      }),
    ).toThrow("must use a dedicated credential");
    expect(() =>
      loadConfig({
        ...enabled,
        PMS_CHANNEX_MANAGEMENT_DATABASE_URL: "postgresql://channex_worker@other-db/app",
      }),
    ).toThrow("must use a dedicated credential");
    expect(() =>
      loadConfig({
        ...enabled,
        PMS_CHANNEX_MANAGEMENT_DATABASE_URL: "postgresql://channex_worker@db/other_app",
      }),
    ).toThrow("must use a dedicated credential");
    expect(() =>
      loadConfig({
        ...enabled,
        TARGET_DATABASE_URL: "postgresql://api_runtime@db/app%2Ftenant",
        PMS_CHANNEX_MANAGEMENT_DATABASE_URL: "postgresql://channex_worker@db/app/tenant",
      }),
    ).toThrow("must use a dedicated credential");
    expect(() =>
      loadConfig({
        ...enabled,
        TARGET_DATABASE_URL: "postgresql://api_runtime@db",
        PMS_CHANNEX_MANAGEMENT_DATABASE_URL: "postgresql://channex_worker@db",
      }),
    ).toThrow("must use a dedicated credential");
    expect(
      loadConfig({
        ...enabled,
        PMS_CHANNEX_MANAGEMENT_DATABASE_URL: "postgresql://channex_worker@db/app",
      }).channexManagement.workerDatabaseUrl,
    ).toBe("postgresql://channex_worker@db/app");
  });

  it("normalizes the Channex management PostgreSQL TLS URL", () => {
    const config = loadConfig({
      TARGET_DATABASE_URL: "postgresql://api_runtime@db/app?sslmode=require",
      PMS_OPERATIONS_SOURCE: "target",
      CHANNEX_API_BASE_URL: "https://staging.channex.io",
      CHANNEX_API_KEY: "secret",
      PMS_CHANNEX_CONNECTION_MODE: "mutating",
      PMS_CHANNEX_WORKER_ENABLED: "true",
      PMS_CHANNEX_MANAGEMENT_DATABASE_URL: "postgresql://channex_worker@db/app?sslmode=require",
    });
    expect(config.channexManagement.workerDatabaseUrl).toContain("uselibpqcompat=true");
  });

  it("requires explicit review cutover and credentials without a management worker", () => {
    const env = {
      TARGET_DATABASE_URL: "postgresql://api_runtime@target-db/app",
      PMS_OPERATIONS_SOURCE: "target",
      CHANNEX_API_BASE_URL: "https://staging.channex.io",
      CHANNEX_API_KEY: "test",
      PMS_CHANNEX_WORKER_ENABLED: "false",
    };
    expect(loadConfig(env).channexManagement.capabilityModes.reviews).toBe("observe_only");
    expect(
      loadConfig({ ...env, PMS_CHANNEX_REVIEWS_MODE: "mutating" }).channexManagement,
    ).toMatchObject({
      workerEnabled: false,
      capabilityModes: { reviews: "mutating", messaging: "observe_only" },
    });
    expect(() => loadConfig({ ...env, PMS_CHANNEX_REVIEWS_MODE: "invalid" })).toThrow(
      "PMS_CHANNEX_REVIEWS_MODE",
    );
    expect(() =>
      loadConfig({ ...env, CHANNEX_API_KEY: "", PMS_CHANNEX_REVIEWS_MODE: "mutating" }),
    ).toThrow("CHANNEX_API_KEY");
  });

  it("does not require the durable worker for an iframe-only cutover", () => {
    expect(
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://api_runtime@target-db/app",
        PMS_OPERATIONS_SOURCE: "target",
        CHANNEX_API_BASE_URL: "https://staging.channex.io",
        CHANNEX_API_KEY: "secret",
        PMS_CHANNEX_IFRAME_MODE: "mutating",
      }).channexManagement,
    ).toMatchObject({ workerEnabled: false, capabilityModes: { iframe: "mutating" } });
  });

  it("requires an explicit legacy-poll freeze before target booking sync mutates", () => {
    const base = {
      TARGET_DATABASE_URL: "postgresql://api_runtime@target-db/app",
      PMS_OPERATIONS_SOURCE: "target",
      CHANNEX_API_BASE_URL: "https://staging.channex.io",
      CHANNEX_API_KEY: "secret",
      PMS_CHANNEX_BOOKING_SYNC_MODE: "mutating",
      PMS_CHANNEX_MANAGEMENT_DATABASE_URL: "postgresql://channex_worker@target-db/app",
    };
    expect(() => loadConfig(base)).toThrow(
      "Mutating PMS Channex booking sync requires CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE=target-owned",
    );
    expect(
      loadConfig({ ...base, CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE: "target-owned" })
        .channexManagement,
    ).toMatchObject({
      bookingMutationOwner: "target",
      workerEnabled: true,
      capabilityModes: { bookingSync: "mutating" },
    });
  });

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

  it("adds libpq compatibility for Postgres SSL database URLs", () => {
    const config = loadConfig({
      AUTH_DATABASE_URL: "postgresql://user:pass@auth-db:5432/auth?sslmode=require",
      WORKOS_JWKS_URL: "https://api.workos.com/sso/jwks/client",
      WORKOS_ISSUER: "https://api.workos.com",
      WORKOS_AUDIENCE: "client",
      TARGET_DATABASE_URL: "postgresql://user:pass@target-db:5432/target?sslmode=require",
      PLATFORM_MEDIA_BUCKET: "vayada-media-staging",
      PLATFORM_MEDIA_CDN_BASE_URL: "https://cdn.staging.vayada.com",
      PLATFORM_MEDIA_CDN_ORIGIN_HOST: "vayada-media-staging.s3.us-east-1.amazonaws.com",
    });

    expect(config.auth?.databaseUrl).toBe(
      "postgresql://user:pass@auth-db:5432/auth?sslmode=require&uselibpqcompat=true",
    );
    expect(config.targetDatabaseUrl).toBe(
      "postgresql://user:pass@target-db:5432/target?sslmode=require&uselibpqcompat=true",
    );
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
        ...completeAuthSessionEnv,
        AUTH_OAUTH_STATE_SECRET: "oauth-state-secret",
        AUTH_FIRST_PARTY_SURFACES: "marketplace-web,pms-web,marketplace-web",
        AUTH_COOKIE_SECURE: "true",
        AUTH_COOKIE_DOMAIN: "localhost",
        AUTH_LEGACY_MARKETPLACE_JWT_SECRET: "legacy-secret",
        AUTH_AFFILIATE_DASHBOARD_LOGOUT_URL: "https://affiliate.localhost/login",
        AUTH_LEGACY_AFFILIATE_PMS_JWT_SECRET: "affiliate-pms-secret",
        AUTH_MARKETPLACE_WEB_LOGOUT_URL: "https://marketplace.localhost/login",
      }).authSession,
    ).toEqual({
      workosClientId: "client",
      workosApiKey: "sk_test",
      authCookieSecret: "cookie-secret",
      oauthStateSecret: "oauth-state-secret",
      authLogoutUrl: "https://admin.localhost/login",
      authAllowedOrigins: [
        "https://admin.localhost",
        "https://api.localhost",
        "https://admin.booking.localhost",
        "https://pms.localhost",
        "https://affiliate.localhost",
        "https://marketplace.localhost",
      ],
      authCompatibilityCallbackOrigin: "https://api.localhost",
      authSurfaceOrigins: {
        "platform-admin": "https://admin.localhost",
        "booking-admin": "https://admin.booking.localhost",
        "pms-web": "https://pms.localhost",
        "affiliate-dashboard": "https://affiliate.localhost",
        "marketplace-web": "https://marketplace.localhost",
      },
      authFirstPartySurfaces: ["marketplace-web", "pms-web"],
      authCookieSecure: true,
      authCookieDomain: "localhost",
      authLegacyMarketplaceJwtSecret: "legacy-secret",
      authAffiliateDashboardLogoutUrl: "https://affiliate.localhost/login",
      authLegacyAffiliatePmsJwtSecret: "affiliate-pms-secret",
      authMarketplaceWebLogoutUrl: "https://marketplace.localhost/login",
    });
  });

  it("rejects partial AuthKit session route config", () => {
    expect(() =>
      loadConfig({
        WORKOS_CLIENT_ID: "client",
      }),
    ).toThrow("Incomplete auth session config");
  });

  it("rejects auth callback origins outside the exact allowlist", () => {
    expect(() =>
      loadConfig({
        ...completeAuthSessionEnv,
        AUTH_MARKETPLACE_WEB_ORIGIN: "https://evil.example",
      }),
    ).toThrow("Auth callback origins must be included in AUTH_ALLOWED_ORIGINS");
  });

  it("rejects malformed auth origins and unsupported rollout surfaces", () => {
    expect(() =>
      loadConfig({
        ...completeAuthSessionEnv,
        AUTH_PMS_WEB_ORIGIN: "https://pms.localhost/login",
      }),
    ).toThrow("AUTH_PMS_WEB_ORIGIN must be an absolute HTTP(S) origin");
    expect(() =>
      loadConfig({
        ...completeAuthSessionEnv,
        AUTH_FIRST_PARTY_SURFACES: "marketplace-web,unknown-surface",
      }),
    ).toThrow("AUTH_FIRST_PARTY_SURFACES contains unsupported surfaces: unknown-surface");
  });

  it("requires secure cookies for enabled HTTPS first-party surfaces", () => {
    expect(() =>
      loadConfig({
        ...completeAuthSessionEnv,
        AUTH_COOKIE_SECURE: "false",
        AUTH_FIRST_PARTY_SURFACES: "marketplace-web",
      }),
    ).toThrow("AUTH_COOKIE_SECURE must be true for HTTPS first-party surfaces: marketplace-web");
  });

  it("loads independently configured creator platform providers", () => {
    expect(
      loadConfig({
        ...completeCreatorPlatformConnectionEnv,
        NODE_ENV: "test",
        CREATOR_PLATFORM_CALLBACK_BASE_URL: "https://creator.api.localhost:1356",
        CREATOR_PLATFORM_WEB_RETURN_URL: "https://marketplace.localhost:1356/profile/complete",
        CREATOR_PLATFORM_CREDENTIAL_VAULT: "memory",
        CREATOR_PLATFORM_SECRET_PREFIX: "vayada/test/creator-platforms",
        TIKTOK_CLIENT_KEY: "client-key",
        TIKTOK_CLIENT_SECRET: "client-secret",
      }).creatorPlatformConnections,
    ).toEqual({
      callbackBaseUrl: "https://creator.api.localhost:1356",
      webReturnUrl: "https://marketplace.localhost:1356/profile/complete",
      sync: {
        enabled: true,
        pollIntervalMs: 60_000,
        recurringIntervalMs: 86_400_000,
        batchSize: 10,
        maxAttempts: 5,
        minimumSpacingMs: { meta: 1_000, tiktok: 2_000, google: 1_000 },
      },
      credentialVault: {
        provider: "memory",
        secretPrefix: "vayada/test/creator-platforms",
      },
      tiktok: { clientKey: "client-key", clientSecret: "client-secret" },
    });
  });

  it("rejects partial creator platform provider config", () => {
    expect(() => loadConfig({ INSTAGRAM_CLIENT_ID: "instagram-client" })).toThrow(
      "Incomplete Instagram creator platform config; missing INSTAGRAM_CLIENT_SECRET, INSTAGRAM_API_VERSION",
    );
  });

  it("rejects the in-memory creator credential vault in production", () => {
    expect(() =>
      loadConfig({
        ...completeCreatorPlatformConnectionEnv,
        NODE_ENV: "production",
        CREATOR_PLATFORM_CALLBACK_BASE_URL: "https://api.example.com",
        CREATOR_PLATFORM_WEB_RETURN_URL: "https://marketplace.example.com/profile/complete",
        CREATOR_PLATFORM_CREDENTIAL_VAULT: "memory",
        CREATOR_PLATFORM_SECRET_PREFIX: "vayada/production/creator-platforms",
        TIKTOK_CLIENT_KEY: "client-key",
        TIKTOK_CLIENT_SECRET: "client-secret",
      }),
    ).toThrow("CREATOR_PLATFORM_CREDENTIAL_VAULT=memory is not allowed in production");
  });

  it("loads target public hotel profile config", () => {
    expect(
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
        PUBLIC_HOTEL_PROFILE_SOURCE: "target",
      }),
    ).toMatchObject({
      targetDatabaseUrl: "postgresql://target-db",
      publicHotelProfileSource: "target",
    });
  });

  it("defaults public hotel profiles to the target source", () => {
    expect(
      loadConfig({ TARGET_DATABASE_URL: "postgresql://target-db" }).publicHotelProfileSource,
    ).toBe("target");
  });

  it("loads active immutable publication profiles", () => {
    expect(
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
        PUBLIC_HOTEL_PROFILE_SOURCE: "active_publication",
      }).publicHotelProfileSource,
    ).toBe("active_publication");
  });

  it("rejects unsupported public profile source config", () => {
    expect(() =>
      loadConfig({
        PUBLIC_HOTEL_PROFILE_SOURCE: "booking",
      }),
    ).toThrow("PUBLIC_HOTEL_PROFILE_SOURCE must be one of: target, active_publication");
  });

  it("loads optional target database config", () => {
    expect(
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
      }).targetDatabaseUrl,
    ).toBe("postgresql://target-db");
  });

  it("loads next API runtime only with target sources", () => {
    const config = loadConfig({
      ...financeFolioKmsEnv,
      API_RUNTIME: "next",
      TARGET_DATABASE_URL: "postgresql://target-db",
      PUBLIC_HOTEL_PROFILE_SOURCE: "target",
      PMS_OPERATIONS_SOURCE: "target",
      FINANCE_SOURCE: "target",
    });

    expect(config).toMatchObject({
      apiRuntime: "next",
      publicHotelProfileSource: "target",
      pmsOperationsSource: "target",
      financeSource: "target",
      financeFolioRecipientKms: {
        currentKeyArn: financeFolioKmsEnv.FINANCE_FOLIO_RECIPIENT_KMS_CURRENT_KEY_ARN,
        allowedKeyArns: financeFolioKmsEnv.FINANCE_FOLIO_RECIPIENT_KMS_ALLOWED_KEY_ARNS.split(","),
        fingerprintKeyArn: financeFolioKmsEnv.FINANCE_FOLIO_RECIPIENT_KMS_FINGERPRINT_KEY_ARN,
        region: "eu-west-1",
      },
    });
  });

  it("loads next API runtime with an explicitly disabled PMS surface", () => {
    const config = loadConfig({
      ...financeFolioKmsEnv,
      API_RUNTIME: "next",
      TARGET_DATABASE_URL: "postgresql://target-db",
      PUBLIC_HOTEL_PROFILE_SOURCE: "target",
      PMS_OPERATIONS_SOURCE: "disabled",
      FINANCE_SOURCE: "target",
    });

    expect(config.pmsOperationsSource).toBe("disabled");
  });

  it("fails closed when the next Finance folio KMS contract is missing or inconsistent", () => {
    const nextFinance = {
      API_RUNTIME: "next",
      TARGET_DATABASE_URL: "postgresql://target-db",
      PUBLIC_HOTEL_PROFILE_SOURCE: "target",
      PMS_OPERATIONS_SOURCE: "disabled",
      FINANCE_SOURCE: "target",
    };
    expect(() => loadConfig(nextFinance)).toThrow("Finance folio recipient KMS config is required");
    expect(() =>
      loadConfig({
        ...nextFinance,
        ...financeFolioKmsEnv,
        FINANCE_FOLIO_RECIPIENT_KMS_ALLOWED_KEY_ARNS:
          financeFolioKmsEnv.FINANCE_FOLIO_RECIPIENT_KMS_FINGERPRINT_KEY_ARN,
      }),
    ).toThrow("Finance folio recipient KMS key ARNs are invalid");
    expect(() =>
      loadConfig({
        ...nextFinance,
        ...financeFolioKmsEnv,
        FINANCE_FOLIO_RECIPIENT_KMS_ALLOWED_KEY_ARNS: `${financeFolioKmsEnv.FINANCE_FOLIO_RECIPIENT_KMS_CURRENT_KEY_ARN},,`,
      }),
    ).toThrow("Finance folio recipient KMS key ARNs are invalid");
    expect(() =>
      loadConfig({
        ...nextFinance,
        ...financeFolioKmsEnv,
        FINANCE_FOLIO_RECIPIENT_KMS_FINGERPRINT_KEY_ARN:
          "arn:aws:kms:us-east-1:123456789012:key/99999999-8888-7777-6666-555555555555",
      }),
    ).toThrow("must share a partition, region, and account");
  });

  it("rejects removed legacy Python integration URL envs in every runtime", () => {
    expect(() =>
      loadConfig({
        BOOKING_PUBLIC_API_URL: "https://api.booking.localhost",
        PMS_API_URL: "https://api.pms.localhost",
        PMS_PUBLIC_API_URL: "https://api.pms.localhost",
      }),
    ).toThrow(
      "apps/api no longer supports legacy Python integration envs: BOOKING_PUBLIC_API_URL, PMS_API_URL, PMS_PUBLIC_API_URL",
    );
  });

  it("loads a canonical replacement-pricing acceptance slug allowlist", () => {
    expect(
      loadConfig({
        REPLACEMENT_PRICING_ACCEPTANCE_ALLOWED_SLUGS: "Test-Hotel, other-hotel,test-hotel",
      }).replacementPricingAcceptanceAllowedSlugs,
    ).toEqual(["test-hotel", "other-hotel"]);
    expect(loadConfig({}).replacementPricingAcceptanceAllowedSlugs).toEqual([]);
  });

  it("rejects malformed replacement-pricing acceptance slugs", () => {
    expect(() =>
      loadConfig({ REPLACEMENT_PRICING_ACCEPTANCE_ALLOWED_SLUGS: "test-hotel,*.vayada.com" }),
    ).toThrow(
      "REPLACEMENT_PRICING_ACCEPTANCE_ALLOWED_SLUGS requires up to 100 canonical lowercase slugs",
    );
  });

  it("rejects next API runtime when source selectors would default to legacy or disabled", () => {
    expect(() =>
      loadConfig({
        API_RUNTIME: "next",
        TARGET_DATABASE_URL: "postgresql://target-db",
      }),
    ).toThrow(
      "API_RUNTIME=next requires target runtime sources: PMS_OPERATIONS_SOURCE=target or explicit disabled, FINANCE_SOURCE=target",
    );
  });

  it("defaults provider webhook intake modes to observe-only shadow intake", () => {
    expect(loadConfig({}).providerWebhooks).toEqual({
      stripeSecret: undefined,
      xenditSecret: undefined,
      channexSecret: undefined,
      resendSecret: undefined,
      stripeMode: "observe_only",
      xenditMode: "observe_only",
      channexMode: "observe_only",
    });
  });

  it("loads provider webhook secrets and per-provider intake modes", () => {
    const config = loadConfig({
      STRIPE_WEBHOOK_SECRET: "stripe-secret",
      XENDIT_WEBHOOK_SECRET: "xendit-secret",
      CHANNEX_WEBHOOK_SECRET: "channex-secret",
      RESEND_WEBHOOK_SECRET: "resend-secret",
      STRIPE_WEBHOOK_INTAKE_MODE: "mutating",
      XENDIT_WEBHOOK_INTAKE_MODE: "ack_only_with_receipt",
      CHANNEX_WEBHOOK_INTAKE_MODE: "observe_only",
      XENDIT_SECRET_KEY: "xendit-api-secret",
    });

    expect(config.providerWebhooks).toEqual({
      stripeSecret: "stripe-secret",
      xenditSecret: "xendit-secret",
      channexSecret: "channex-secret",
      resendSecret: "resend-secret",
      stripeMode: "mutating",
      xenditMode: "ack_only_with_receipt",
      channexMode: "observe_only",
    });
    expect(config.xenditSecretKey).toBe("xendit-api-secret");
  });

  it("loads Xendit bank-validation secret independently of webhook intake", () => {
    expect(
      loadConfig({
        XENDIT_SECRET_KEY: "xendit-api-secret",
      }).xenditSecretKey,
    ).toBe("xendit-api-secret");
  });

  it("loads Stripe subscription billing separately from webhook verification", () => {
    expect(
      loadConfig({
        STRIPE_SECRET_KEY: "sk_test_subscription",
        STRIPE_FIXED_PLAN_PRICE_ID: "price_fixed",
        BOOKING_ADMIN_BASE_URL: "https://admin.booking.example",
      }).stripeSubscriptions,
    ).toEqual({
      secretKey: "sk_test_subscription",
      fixedPlanPriceId: "price_fixed",
      bookingAdminBaseUrl: "https://admin.booking.example",
    });
  });

  it("enables Stripe Checkout only when subscription mutation and webhook recovery are ready", () => {
    const stripeRuntimeEnv = {
      ...completeAuthSessionEnv,
      TARGET_DATABASE_URL: "postgresql://target-db",
      FINANCE_SOURCE: "target",
      STRIPE_SECRET_KEY: "sk_test_subscription",
      STRIPE_FIXED_PLAN_PRICE_ID: "price_fixed",
      STRIPE_WEBHOOK_SECRET: "whsec_subscription",
      STRIPE_WEBHOOK_INTAKE_MODE: "mutating",
    };
    const complete = loadConfig(stripeRuntimeEnv);
    expect(stripeSubscriptionRuntimeEnabled(complete)).toBe(true);
    expect(
      stripeSubscriptionRuntimeEnabled(
        loadConfig({ ...stripeRuntimeEnv, STRIPE_FIXED_PLAN_PRICE_ID: undefined }),
      ),
    ).toBe(true);

    for (const env of [
      { ...stripeRuntimeEnv, STRIPE_SECRET_KEY: undefined },
      { ...stripeRuntimeEnv, STRIPE_WEBHOOK_SECRET: undefined },
      { ...stripeRuntimeEnv, STRIPE_WEBHOOK_INTAKE_MODE: "observe_only" },
    ]) {
      expect(stripeSubscriptionRuntimeEnabled(loadConfig(env))).toBe(false);
    }
  });

  it("requires an explicit PMS return origin when Stripe subscriptions are enabled", () => {
    expect(() =>
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
        FINANCE_SOURCE: "target",
        STRIPE_SECRET_KEY: "sk_test_subscription",
        STRIPE_WEBHOOK_SECRET: "whsec_subscription",
        STRIPE_WEBHOOK_INTAKE_MODE: "mutating",
      }),
    ).toThrow("Stripe subscriptions require AUTH_PMS_WEB_ORIGIN");
  });

  it("rejects a non-HTTP Booking Admin return origin", () => {
    expect(() => loadConfig({ BOOKING_ADMIN_BASE_URL: "ftp://admin.booking.example" })).toThrow(
      "BOOKING_ADMIN_BASE_URL must be an absolute HTTP(S) origin",
    );
  });

  it("rejects unsupported provider webhook intake modes", () => {
    expect(() =>
      loadConfig({
        STRIPE_WEBHOOK_INTAKE_MODE: "proxy_to_target",
      }),
    ).toThrow(
      "STRIPE_WEBHOOK_INTAKE_MODE must be one of: observe_only, mutating, ack_only_with_receipt",
    );
  });

  it("defaults Booking Web event sink to disabled until target auth config is explicit", () => {
    expect(loadConfig({}).bookingWebEventSink).toBe("disabled");
  });

  it("can disable the Booking Web event sink for local no-op intake", () => {
    expect(
      loadConfig({
        BOOKING_WEB_EVENT_SINK: "disabled",
      }).bookingWebEventSink,
    ).toBe("disabled");
  });

  it("loads target Booking Web event sink config", () => {
    expect(
      loadConfig({
        ...completeCreatorMarketplaceEnv,
        PUBLIC_HOTEL_PROFILE_SOURCE: "target",
        BOOKING_WEB_EVENT_SINK: "target",
      }).bookingWebEventSink,
    ).toBe("target");
  });

  it("loads target Booking Web events with active publication profiles", () => {
    expect(
      loadConfig({
        ...completeCreatorMarketplaceEnv,
        PUBLIC_HOTEL_PROFILE_SOURCE: "active_publication",
        BOOKING_WEB_EVENT_SINK: "target",
      }).bookingWebEventSink,
    ).toBe("target");
  });

  it("requires auth config for the target Booking Web event sink", () => {
    expect(() =>
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
        PUBLIC_HOTEL_PROFILE_SOURCE: "target",
        BOOKING_WEB_EVENT_SINK: "target",
      }),
    ).toThrow("BOOKING_WEB_EVENT_SINK=target requires complete auth config");
  });

  it("rejects unsupported Booking Web event sink config", () => {
    expect(() =>
      loadConfig({
        BOOKING_WEB_EVENT_SINK: "legacy",
      }),
    ).toThrow("BOOKING_WEB_EVENT_SINK must be one of: disabled, target");
  });

  it("keeps marketplace admin legacy superadmin fallback disabled by default", () => {
    expect(loadConfig({}).marketplaceAdminLegacySuperadminFallbackEnabled).toBe(false);
    expect(
      loadConfig({
        MARKETPLACE_ADMIN_LEGACY_SUPERADMIN_FALLBACK_ENABLED: "true",
      }).marketplaceAdminLegacySuperadminFallbackEnabled,
    ).toBe(true);
  });

  it("requires durable media whenever target Marketplace and auth make the server creator-capable", () => {
    expect(loadConfig(completeCreatorMarketplaceEnv).platformMediaServing).toBeDefined();
    expect(() =>
      loadConfig({
        ...completeCreatorMarketplaceEnv,
        PLATFORM_MEDIA_BUCKET: undefined,
        PLATFORM_MEDIA_CDN_BASE_URL: undefined,
        PLATFORM_MEDIA_CDN_ORIGIN_HOST: undefined,
      }),
    ).toThrow(
      "Target Marketplace with complete auth requires complete PLATFORM_MEDIA_* config because creator profile photos are required",
    );
  });

  it("keeps PMS operations routes disabled by default", () => {
    expect(loadConfig({}).pmsOperationsSource).toBe("disabled");
  });

  it("loads target PMS operations config", () => {
    const config = loadConfig({
      TARGET_DATABASE_URL: "postgresql://target-db",
      PMS_OPERATIONS_SOURCE: "target",
    });

    expect(config.pmsOperationsSource).toBe("target");
    expect(config.pmsOperationsAllowedOrigins).toEqual([
      "https://pms.localhost",
      "https://admin.booking.localhost",
      "https://marketplace.localhost",
    ]);
  });

  it("loads PMS operations allowed origins from comma-separated config", () => {
    expect(
      loadConfig({
        PMS_OPERATIONS_ALLOWED_ORIGINS: "https://pms.localhost, https://pms.vayada.com,",
      }).pmsOperationsAllowedOrigins,
    ).toEqual(["https://pms.localhost", "https://pms.vayada.com"]);
  });

  it("requires target database config when PMS operations use the target source", () => {
    expect(() =>
      loadConfig({
        PMS_OPERATIONS_SOURCE: "target",
      }),
    ).toThrow("TARGET_DATABASE_URL is required when PMS_OPERATIONS_SOURCE=target");
  });

  it("rejects unsupported PMS operations source config", () => {
    expect(() =>
      loadConfig({
        PMS_OPERATIONS_SOURCE: "legacy",
      }),
    ).toThrow("PMS_OPERATIONS_SOURCE must be one of: disabled, target");
  });

  it("keeps finance reads on the legacy source by default", () => {
    expect(loadConfig({}).financeSource).toBe("legacy");
  });

  it("loads target finance reads without legacy product database config", () => {
    expect(
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
        FINANCE_SOURCE: "target",
      }).financeSource,
    ).toBe("target");
  });

  it("requires target database config when finance reads use the target source", () => {
    expect(() =>
      loadConfig({
        FINANCE_SOURCE: "target",
      }),
    ).toThrow("FINANCE_SOURCE=target requires TARGET_DATABASE_URL");
  });

  it("rejects unsupported finance source config", () => {
    expect(() =>
      loadConfig({
        FINANCE_SOURCE: "preview",
      }),
    ).toThrow("FINANCE_SOURCE must be one of: legacy, target");
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

  it("requires booking email delivery for checkout in production", () => {
    expect(() =>
      loadConfig({
        ...completeAuthSessionEnv,
        NODE_ENV: "production",
        TARGET_DATABASE_URL: "postgresql://target-db",
      }),
    ).toThrow("requires RESEND_API_KEY and BOOKING_EMAIL_FROM");

    expect(
      loadConfig({
        ...completeAuthSessionEnv,
        NODE_ENV: "production",
        TARGET_DATABASE_URL: "postgresql://target-db",
        RESEND_API_KEY: "re_test",
        BOOKING_EMAIL_FROM: "Vayada <bookings@example.test>",
        FINANCE_SOURCE: "target",
        STRIPE_SECRET_KEY: "sk_test",
        STRIPE_WEBHOOK_SECRET: "whsec_test",
        STRIPE_WEBHOOK_INTAKE_MODE: "mutating",
      }).bookingEmailDelivery,
    ).toEqual({
      provider: "resend",
      apiKey: "re_test",
      from: "Vayada <bookings@example.test>",
    });
  });

  it("requires the Stripe mutation and recovery runtime for checkout in production", () => {
    const complete = {
      ...financeFolioKmsEnv,
      ...completeAuthSessionEnv,
      NODE_ENV: "production",
      API_RUNTIME: "next",
      TARGET_DATABASE_URL: "postgresql://target-db",
      PUBLIC_HOTEL_PROFILE_SOURCE: "target",
      PMS_OPERATIONS_SOURCE: "target",
      FINANCE_SOURCE: "target",
      RESEND_API_KEY: "re_test",
      BOOKING_EMAIL_FROM: "Vayada <bookings@example.test>",
      STRIPE_SECRET_KEY: "sk_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_WEBHOOK_INTAKE_MODE: "mutating",
    };
    expect(stripeSubscriptionRuntimeEnabled(loadConfig(complete))).toBe(true);
    for (const env of [
      { ...complete, STRIPE_SECRET_KEY: undefined },
      { ...complete, STRIPE_WEBHOOK_SECRET: undefined },
      { ...complete, STRIPE_WEBHOOK_INTAKE_MODE: "observe_only" },
    ]) {
      expect(() => loadConfig(env)).toThrow("requires STRIPE_SECRET_KEY");
    }
    expect(() => loadConfig({ ...complete, FINANCE_SOURCE: "legacy" })).toThrow(
      "API_RUNTIME=next requires target runtime sources: FINANCE_SOURCE=target",
    );
  });

  it("loads optional booking host base config", () => {
    expect(
      loadConfig({
        BOOKING_HOST_BASE: "booking.localhost",
      }).bookingHostBase,
    ).toBe("booking.localhost");
  });

  it("keeps platform media serving inactive by default", () => {
    expect(loadConfig({}).platformMediaServing).toBeUndefined();
  });

  it("configures and can disable the platform media cleanup interval", () => {
    expect(loadConfig({})).toMatchObject({
      platformMediaCleanupEnabled: true,
      platformMediaCleanupIntervalMs: 15 * 60 * 1000,
    });
    expect(
      loadConfig({
        PLATFORM_MEDIA_CLEANUP_ENABLED: "false",
        PLATFORM_MEDIA_CLEANUP_INTERVAL_MS: "60000",
      }),
    ).toMatchObject({
      platformMediaCleanupEnabled: false,
      platformMediaCleanupIntervalMs: 60_000,
    });
    expect(() => loadConfig({ PLATFORM_MEDIA_CLEANUP_INTERVAL_MS: "0" })).toThrow(
      "PLATFORM_MEDIA_CLEANUP_INTERVAL_MS must be a positive integer",
    );
  });

  it("configures and can disable property setup draft retention", () => {
    expect(loadConfig({})).toMatchObject({
      propertySetupDraftRetentionEnabled: true,
      propertySetupDraftRetentionIntervalMs: 60 * 60 * 1000,
      propertySetupDraftRetentionBatchSize: 100,
    });
    expect(
      loadConfig({
        PROPERTY_SETUP_DRAFT_RETENTION_ENABLED: "false",
        PROPERTY_SETUP_DRAFT_RETENTION_INTERVAL_MS: "60000",
        PROPERTY_SETUP_DRAFT_RETENTION_BATCH_SIZE: "25",
      }),
    ).toMatchObject({
      propertySetupDraftRetentionEnabled: false,
      propertySetupDraftRetentionIntervalMs: 60_000,
      propertySetupDraftRetentionBatchSize: 25,
    });
    expect(() => loadConfig({ PROPERTY_SETUP_DRAFT_RETENTION_BATCH_SIZE: "0" })).toThrow(
      "PROPERTY_SETUP_DRAFT_RETENTION_BATCH_SIZE must be a positive integer",
    );
    expect(() => loadConfig({ PROPERTY_SETUP_DRAFT_RETENTION_INTERVAL_MS: "0" })).toThrow(
      "PROPERTY_SETUP_DRAFT_RETENTION_INTERVAL_MS must be a positive integer",
    );
    expect(() => loadConfig({ PROPERTY_SETUP_DRAFT_RETENTION_INTERVAL_MS: "2147483648" })).toThrow(
      "PROPERTY_SETUP_DRAFT_RETENTION_INTERVAL_MS must not exceed 2147483647",
    );
  });

  it("configures and can disable the PMS public-offer retry interval", () => {
    expect(loadConfig({})).toMatchObject({
      pmsInventoryPublicOfferRetryEnabled: true,
      pmsInventoryPublicOfferRetryIntervalMs: 30_000,
    });
    expect(
      loadConfig({
        PMS_INVENTORY_PUBLIC_OFFER_RETRY_ENABLED: "false",
        PMS_INVENTORY_PUBLIC_OFFER_RETRY_INTERVAL_MS: "60000",
      }),
    ).toMatchObject({
      pmsInventoryPublicOfferRetryEnabled: false,
      pmsInventoryPublicOfferRetryIntervalMs: 60_000,
    });
    expect(() => loadConfig({ PMS_INVENTORY_PUBLIC_OFFER_RETRY_INTERVAL_MS: "0" })).toThrow(
      "PMS_INVENTORY_PUBLIC_OFFER_RETRY_INTERVAL_MS must be a positive integer",
    );
  });

  it("loads platform media serving cutover config", () => {
    expect(
      loadConfig({
        PLATFORM_MEDIA_BUCKET: "vayada-media-staging",
        PLATFORM_MEDIA_CDN_BASE_URL: "https://cdn.staging.vayada.com",
        PLATFORM_MEDIA_CDN_ORIGIN_HOST: "vayada-media-staging.s3.us-east-1.amazonaws.com",
      }).platformMediaServing,
    ).toMatchObject({
      bucketName: "vayada-media-staging",
      cdnBaseUrl: "https://cdn.staging.vayada.com",
      cdnOriginHost: "vayada-media-staging.s3.us-east-1.amazonaws.com",
      publicPathPrefix: "media",
      privateDownloadTtlSeconds: 300,
      privateDownloadMaxTtlSeconds: 900,
    });
  });

  it("keeps partial optional platform media config dark", () => {
    expect(
      loadConfig({
        PLATFORM_MEDIA_CDN_BASE_URL: "https://cdn.vayada.com",
      }).platformMediaServing,
    ).toBeUndefined();
  });

  it("rejects partial platform media config for a creator-capable server", () => {
    expect(() =>
      loadConfig({
        ...completeCreatorMarketplaceEnv,
        PLATFORM_MEDIA_BUCKET: undefined,
        PLATFORM_MEDIA_CDN_BASE_URL: "https://cdn.vayada.com",
        PLATFORM_MEDIA_CDN_ORIGIN_HOST: undefined,
      }),
    ).toThrow("Incomplete platform media serving config");
  });

  it("still rejects invalid complete optional platform media config", () => {
    expect(() =>
      loadConfig({
        PLATFORM_MEDIA_BUCKET: "vayada-media-production",
        PLATFORM_MEDIA_CDN_BASE_URL: "http://cdn.vayada.com",
        PLATFORM_MEDIA_CDN_ORIGIN_HOST: "vayada-media-production.s3.us-east-1.amazonaws.com",
      }),
    ).toThrow("PLATFORM_MEDIA_CDN_BASE_URL must be an HTTPS origin");
  });
});

describe("API background worker configuration", () => {
  it("defaults to enabled and allows a request-only staging API", () => {
    expect(loadConfig({}).backgroundWorkersEnabled).toBe(true);
    expect(loadConfig({ API_BACKGROUND_WORKERS_ENABLED: "false" }).backgroundWorkersEnabled).toBe(
      false,
    );
    expect(() => loadConfig({ API_BACKGROUND_WORKERS_ENABLED: "invalid" })).toThrow();
  });
});

describe("Airbnb alteration runtime opt-in", () => {
  const propertyId = "00000000-0000-4000-8000-000000000001";
  const enabled = {
    ...completeCreatorMarketplaceEnv,
    ...completeAuthSessionEnv,
    AIRBNB_ALTERATIONS_ENABLED: "true",
    AIRBNB_ALTERATION_PROPERTY_IDS: propertyId,
    PMS_OPERATIONS_SOURCE: "target",
    TARGET_DATABASE_URL: "postgresql://api_runtime@target-db/app",
    API_BACKGROUND_WORKERS_ENABLED: "true",
    PMS_CHANNEX_WORKER_ENABLED: "true",
    PMS_CHANNEX_MANAGEMENT_DATABASE_URL: "postgresql://channex_worker@target-db/app",
    PMS_CHANNEX_BOOKING_SYNC_MODE: "mutating",
    CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE: "target-owned",
    CHANNEX_WEBHOOK_INTAKE_MODE: "mutating",
    CHANNEX_WEBHOOK_SECRET: "test-secret",
    CHANNEX_API_BASE_URL: "https://staging.channex.io",
    CHANNEX_API_KEY: "test-key",
  };
  it("stays off by default and independent of listing import", () => {
    expect(loadConfig({}).airbnbAlterations).toBeUndefined();
    expect(
      loadConfig({
        ...enabled,
        AIRBNB_ALTERATIONS_ENABLED: "false",
        AIRBNB_ALTERATION_PROPERTY_IDS: "bad",
        AIRBNB_IMPORT_ENABLED: "true",
        AIRBNB_IMPORT_CALLBACK_ORIGIN: "https://marketplace.localhost",
      }).airbnbAlterations,
    ).toBeUndefined();
  });
  it("normalizes and deduplicates an explicit property allowlist", () => {
    const id = "ABCDEFAB-ABCD-4000-8000-ABCDEFABCDEF";
    expect(
      loadConfig({
        ...enabled,
        AIRBNB_ALTERATION_PROPERTY_IDS: ` ${propertyId},${id},${id.toLowerCase()}`,
      }).airbnbAlterations,
    ).toEqual({ propertyIds: [propertyId, id.toLowerCase()] });
  });
  it.each([
    undefined,
    "",
    "not-a-uuid",
    "00000000-0000-9000-0000-000000000001",
    `${propertyId},`,
    Array.from(
      { length: 101 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    ).join(","),
  ])("rejects invalid property scopes", (value) => {
    expect(() => loadConfig({ ...enabled, AIRBNB_ALTERATION_PROPERTY_IDS: value })).toThrow(
      "AIRBNB_ALTERATION_PROPERTY_IDS",
    );
  });
  it.each([
    { API_BACKGROUND_WORKERS_ENABLED: "false" },
    { PMS_CHANNEX_WORKER_ENABLED: "false" },
    { PMS_CHANNEX_BOOKING_SYNC_MODE: "observe_only" },
    { CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE: "legacy-owned" },
    { CHANNEX_WEBHOOK_INTAKE_MODE: "observe_only" },
    { CHANNEX_WEBHOOK_SECRET: "" },
    { CHANNEX_API_KEY: "" },
    { CHANNEX_API_BASE_URL: "" },
    { PMS_OPERATIONS_SOURCE: "disabled" },
    { WORKOS_JWKS_URL: "", WORKOS_ISSUER: "", WORKOS_AUDIENCE: "", AUTH_DATABASE_URL: "" },
    { WORKOS_CLIENT_ID: "" },
  ])("rejects missing required runtime dependency %j", (overrides) => {
    expect(() => loadConfig({ ...enabled, ...overrides })).toThrow();
  });
  it.each([
    "http://staging.channex.io",
    "https://evil.example",
    "https://app.channex.io.evil.example",
  ])("rejects unapproved provider URL %s", (url) => {
    expect(() => loadConfig({ ...enabled, CHANNEX_API_BASE_URL: url })).toThrow(
      "approved Channex API URL",
    );
  });
  it.each([
    "https://app.channex.io",
    "https://staging.channex.io/",
    "https://app.channex.io/api/v1/",
  ])("accepts supported provider base %s", (url) => {
    expect(loadConfig({ ...enabled, CHANNEX_API_BASE_URL: url }).airbnbAlterations).toEqual({
      propertyIds: [propertyId],
    });
  });
  it("rejects invalid enabled flag", () => {
    expect(() => loadConfig({ AIRBNB_ALTERATIONS_ENABLED: "sometimes" })).toThrow(
      "AIRBNB_ALTERATIONS_ENABLED",
    );
  });
});

describe("Finance expense worker boundary config", () => {
  const env = {
    FINANCE_SOURCE: "target",
    TARGET_DATABASE_URL: "postgresql://api:fixture@localhost/target",
    FINANCE_EXPENSE_WORKER_ENABLED: "true",
    FINANCE_EXPENSE_WORKER_DATABASE_URL:
      "postgresql://vayada_next_finance_expense_worker:fixture@localhost/target",
    FINANCE_EXPENSE_WORKER_PROPERTY_ID: "20440000-0000-4000-8000-000000000001",
  };
  it("defaults paused without opening a worker credential", () => {
    expect(loadConfig({}).financeExpenseWorker).toBeUndefined();
    expect(
      loadConfig({
        ...env,
        FINANCE_EXPENSE_WORKER_ENABLED: "false",
        FINANCE_EXPENSE_WORKER_DATABASE_URL: "invalid",
      }).financeExpenseWorker,
    ).toBeUndefined();
  });
  it("requires the dedicated login, target database, property, and both worker gates", () => {
    expect(loadConfig(env).financeExpenseWorker).toEqual({
      databaseUrl: env.FINANCE_EXPENSE_WORKER_DATABASE_URL,
      propertyId: env.FINANCE_EXPENSE_WORKER_PROPERTY_ID,
    });
    for (const overrides of [
      { FINANCE_EXPENSE_WORKER_DATABASE_URL: "" },
      { FINANCE_EXPENSE_WORKER_PROPERTY_ID: "" },
      { API_BACKGROUND_WORKERS_ENABLED: "false" },
      { FINANCE_SOURCE: "legacy" },
      { FINANCE_EXPENSE_WORKER_DATABASE_URL: env.TARGET_DATABASE_URL },
      {
        FINANCE_EXPENSE_WORKER_DATABASE_URL:
          env.FINANCE_EXPENSE_WORKER_DATABASE_URL + "?options=-crole=postgres",
      },
      {
        FINANCE_EXPENSE_WORKER_DATABASE_URL: env.FINANCE_EXPENSE_WORKER_DATABASE_URL.replace(
          "/target",
          "/other",
        ),
      },
    ])
      expect(() => loadConfig({ ...env, ...overrides })).toThrow();
  });
});

describe("Finance export worker boundary config", () => {
  const env = {
    FINANCE_SOURCE: "target",
    TARGET_DATABASE_URL: "postgresql://api:fixture@localhost/target",
    FINANCE_EXPORT_WORKER_ENABLED: "true",
    FINANCE_EXPORT_WORKER_DATABASE_URL:
      "postgresql://vayada_next_finance_export_worker:fixture@localhost/target",
    FINANCE_EXPORT_WORKER_PROPERTY_ID: "20450000-0000-4000-8000-000000000001",
  };
  it("defaults paused without opening the credential", () => {
    expect(loadConfig({}).financeExportWorker).toBeUndefined();
    expect(
      loadConfig({
        ...env,
        FINANCE_EXPORT_WORKER_ENABLED: "false",
        FINANCE_EXPORT_WORKER_DATABASE_URL: "invalid",
      }).financeExportWorker,
    ).toBeUndefined();
  });
  it("requires the dedicated login, target database, property, and worker gates", () => {
    expect(loadConfig(env).financeExportWorker).toEqual({
      databaseUrl: env.FINANCE_EXPORT_WORKER_DATABASE_URL,
      propertyId: env.FINANCE_EXPORT_WORKER_PROPERTY_ID,
    });
    for (const overrides of [
      { FINANCE_EXPORT_WORKER_DATABASE_URL: "" },
      { FINANCE_EXPORT_WORKER_PROPERTY_ID: "" },
      { API_BACKGROUND_WORKERS_ENABLED: "false" },
      { FINANCE_SOURCE: "legacy" },
      { FINANCE_EXPORT_WORKER_DATABASE_URL: env.TARGET_DATABASE_URL },
      {
        FINANCE_EXPORT_WORKER_DATABASE_URL: `${env.FINANCE_EXPORT_WORKER_DATABASE_URL}?options=-crole=postgres`,
      },
      {
        FINANCE_EXPORT_WORKER_DATABASE_URL: env.FINANCE_EXPORT_WORKER_DATABASE_URL.replace(
          "/target",
          "/other",
        ),
      },
    ])
      expect(() => loadConfig({ ...env, ...overrides })).toThrow();
  });
});
