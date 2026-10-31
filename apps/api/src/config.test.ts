import { describe, expect, it } from "vitest";

import {
  channexClaimedAriScope,
  channexClaimedScope,
  loadConfig,
  replacementPricingManualPaymentMethods,
  stripeSubscriptionRuntimeEnabled,
} from "./config.js";

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

const completeAuthSessionEnv = {
  WORKOS_CLIENT_ID: "client",
  WORKOS_API_KEY: "sk_test",
  AUTH_COOKIE_SECRET: "cookie-secret",
  AUTH_LOGOUT_URL: "https://admin.localhost/login",
  AUTH_ALLOWED_ORIGINS:
    "https://admin.localhost, https://api.localhost, https://admin.booking.localhost, " +
    "https://pms.localhost",
  AUTH_COMPATIBILITY_CALLBACK_ORIGIN: "https://api.localhost",
  AUTH_PLATFORM_ADMIN_ORIGIN: "https://admin.localhost",
  AUTH_BOOKING_ADMIN_ORIGIN: "https://admin.booking.localhost",
  AUTH_PMS_WEB_ORIGIN: "https://pms.localhost",
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

  it("keeps the room type Delete cleanup off unless properties are listed (VAY-2132)", () => {
    const key = "PMS_ROOM_TYPE_DELETE_CLEANUP_PROPERTY_IDS";
    expect(loadConfig({}).pmsRoomTypeDeleteCleanupPropertyIds).toEqual([]);
    expect(loadConfig({ [key]: " " }).pmsRoomTypeDeleteCleanupPropertyIds).toEqual([]);
    expect(loadConfig({ [key]: "*" }).pmsRoomTypeDeleteCleanupPropertyIds).toBe("all");
    expect(
      loadConfig({ [key]: "1DEE5712-6074-4FB0-8B1D-EC3601943526" })
        .pmsRoomTypeDeleteCleanupPropertyIds,
    ).toEqual(["1dee5712-6074-4fb0-8b1d-ec3601943526"]);
    expect(() => loadConfig({ [key]: "sri-journeys" })).toThrow(key);
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

  it("loads the VAY-2108 claimed scope only with a strict owned-property allowlist", () => {
    const owned = "29f39aae-0000-4000-8000-000000000001,7d3f6dcc-0000-4000-8000-000000000002";
    const production = {
      TARGET_DATABASE_URL: "postgresql://api_runtime@target-db/app",
      PMS_OPERATIONS_SOURCE: "target",
      CHANNEX_API_BASE_URL: "https://app.channex.io",
      CHANNEX_API_KEY: "secret",
      CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE: "target-owned",
      PMS_CHANNEX_SCOPE: "claimed",
      PMS_CHANNEX_OWNED_PROPERTY_IDS: owned,
      PMS_CHANNEX_CONNECTION_MODE: "mutating",
      PMS_CHANNEX_BOOKING_SYNC_MODE: "mutating",
      PMS_CHANNEX_WORKER_ENABLED: "true",
      PMS_CHANNEX_MANAGEMENT_DATABASE_URL: "postgresql://channex_worker@target-db/app",
    };
    const config = loadConfig(production).channexManagement;
    expect(config).toMatchObject({ scope: "claimed", ownedPropertyIds: owned.split(",") });
    expect(channexClaimedScope(config)).toBe(true);
    // The S1 canary: staging Channex, booking only, no worker, background workers off.
    const canary = loadConfig({
      ...production,
      CHANNEX_API_BASE_URL: "https://staging.channex.io",
      PMS_CHANNEX_OWNED_PROPERTY_IDS: "65f6b2fc-c783-4963-9d6b-a85f82319769",
      PMS_CHANNEX_CONNECTION_MODE: "observe_only",
      PMS_CHANNEX_WORKER_ENABLED: "false",
      PMS_CHANNEX_MANAGEMENT_DATABASE_URL: undefined,
      API_BACKGROUND_WORKERS_ENABLED: "false",
    }).channexManagement;
    expect(canary).toMatchObject({ workerEnabled: false, scope: "claimed" });
    // Inert: an empty list owns nothing, and booking sync may be off under the scope.
    expect(
      loadConfig({
        ...production,
        PMS_CHANNEX_OWNED_PROPERTY_IDS: "",
        PMS_CHANNEX_BOOKING_SYNC_MODE: "observe_only",
      }).channexManagement.ownedPropertyIds,
    ).toEqual([]);
    expect(
      loadConfig({
        ...production,
        PMS_CHANNEX_SCOPE: undefined,
        PMS_CHANNEX_OWNED_PROPERTY_IDS: undefined,
      }).channexManagement.scope,
    ).toBeUndefined();
    // Booking-only claimed defaults the management worker off.
    expect(
      loadConfig({
        ...production,
        PMS_CHANNEX_CONNECTION_MODE: undefined,
        PMS_CHANNEX_WORKER_ENABLED: undefined,
        PMS_CHANNEX_MANAGEMENT_DATABASE_URL: undefined,
      }).channexManagement.workerEnabled,
    ).toBe(false);
    // D7: ARI and provisioning together, on the worker, on top of booking sync.
    const ari = loadConfig({
      ...production,
      PMS_CHANNEX_ARI_SYNC_MODE: "mutating",
      PMS_CHANNEX_PROVISIONING_MODE: "mutating",
      PMS_CHANNEX_OFFER_ARI_DELIVERY_ENABLED: "true",
    }).channexManagement;
    expect(ari).toMatchObject({
      scope: "claimed",
      workerEnabled: true,
      offerAriDeliveryEnabled: true,
    });
    expect(channexClaimedScope(ari)).toBe(true);
    expect(channexClaimedAriScope(ari)).toBe(true);
    expect(channexClaimedAriScope(config)).toBe(false);
    // The ARI scope needs the worker even without the connection scope.
    expect(() =>
      loadConfig({
        ...production,
        PMS_CHANNEX_ARI_SYNC_MODE: "mutating",
        PMS_CHANNEX_PROVISIONING_MODE: "mutating",
        PMS_CHANNEX_CONNECTION_MODE: undefined,
        PMS_CHANNEX_WORKER_ENABLED: "false",
      }),
    ).toThrow(/PMS_CHANNEX_WORKER_ENABLED=true/);
    const only = /requires PMS_CHANNEX_OWNED_PROPERTY_IDS|required with, and only with/;
    const format = /distinct lowercase UUIDs/;
    const scope = /allows only connection, booking sync and reviews/;
    for (const [invalid, message] of [
      [{ PMS_CHANNEX_SCOPE: "all" }, /must be claimed/],
      [{ PMS_CHANNEX_OWNED_PROPERTY_IDS: undefined }, only],
      [{ PMS_CHANNEX_SCOPE: undefined }, only],
      [{ PMS_CHANNEX_OWNED_PROPERTY_IDS: owned.toUpperCase() }, format],
      [{ PMS_CHANNEX_OWNED_PROPERTY_IDS: owned.replace(",", ", ") }, format],
      [{ PMS_CHANNEX_OWNED_PROPERTY_IDS: `${owned},` }, format],
      [{ PMS_CHANNEX_OWNED_PROPERTY_IDS: `${owned.split(",")[0]},${owned.split(",")[0]}` }, format],
      [{ PMS_CHANNEX_OWNED_PROPERTY_IDS: "65f6b2fc-c783-4963-9d6b-a85f82319769" }, /reserved/],
      [{ PMS_CHANNEX_ARI_SYNC_MODE: "mutating" }, scope],
      [{ PMS_CHANNEX_PROVISIONING_MODE: "mutating" }, scope],
      [
        {
          PMS_CHANNEX_ARI_SYNC_MODE: "mutating",
          PMS_CHANNEX_PROVISIONING_MODE: "mutating",
          PMS_CHANNEX_BOOKING_SYNC_MODE: "observe_only",
        },
        scope,
      ],
      [{ PMS_CHANNEX_OFFER_ARI_DELIVERY_ENABLED: "true" }, /requires a mutating ARI sync/],
      [{ PMS_CHANNEX_MESSAGING_MODE: "mutating" }, scope],
      [{ PMS_CHANNEX_IFRAME_MODE: "mutating" }, scope],
      [{ CHANNEX_API_BASE_URL: "https://example.channex.test" }, scope],
      [
        { CHANNEX_WEBHOOK_INTAKE_MODE: "mutating", CHANNEX_WEBHOOK_SECRET: "token" },
        /CHANNEX_WEBHOOK_INTAKE_MODE observe_only/,
      ],
      [{ PMS_CHANNEX_WORKER_ENABLED: "false" }, /PMS_CHANNEX_WORKER_ENABLED=true/],
    ] as const)
      expect(() => loadConfig({ ...production, ...invalid }), JSON.stringify(invalid)).toThrow(
        message,
      );
    expect(() =>
      loadConfig({
        ...production,
        CHANNEX_API_BASE_URL: "https://staging.channex.io",
        PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: "65f6b2fc-c783-4963-9d6b-a85f82319769",
      }),
    ).toThrow();
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
        AUTH_FIRST_PARTY_SURFACES: "booking-admin,pms-web,booking-admin",
        AUTH_COOKIE_SECURE: "true",
        AUTH_COOKIE_DOMAIN: "localhost",
        // VAY-2259: still set in production until the platform mapping goes; now ignored.
        AUTH_LEGACY_MARKETPLACE_JWT_SECRET: "legacy-secret",
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
      ],
      authCompatibilityCallbackOrigin: "https://api.localhost",
      authSurfaceOrigins: {
        "platform-admin": "https://admin.localhost",
        "booking-admin": "https://admin.booking.localhost",
        "pms-web": "https://pms.localhost",
      },
      authFirstPartySurfaces: ["booking-admin", "pms-web"],
      authCookieSecure: true,
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

  // VAY-2271: the retired Marketplace and affiliate surfaces are unknown now.
  it("rejects the retired Marketplace and affiliate login addresses and surfaces", () => {
    expect(
      loadConfig({
        ...completeAuthSessionEnv,
        AUTH_MARKETPLACE_WEB_ORIGIN: "https://marketplace.localhost",
        AUTH_AFFILIATE_DASHBOARD_ORIGIN: "https://affiliate.localhost",
      }).authSession?.authSurfaceOrigins,
    ).toEqual({
      "platform-admin": "https://admin.localhost",
      "booking-admin": "https://admin.booking.localhost",
      "pms-web": "https://pms.localhost",
    });
    expect(() =>
      loadConfig({
        ...completeAuthSessionEnv,
        AUTH_FIRST_PARTY_SURFACES: "marketplace-web",
      }),
    ).toThrow("AUTH_FIRST_PARTY_SURFACES contains unsupported surfaces: marketplace-web");
  });

  it("rejects auth callback origins outside the exact allowlist", () => {
    expect(() =>
      loadConfig({
        ...completeAuthSessionEnv,
        AUTH_PMS_WEB_ORIGIN: "https://evil.example",
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
        AUTH_FIRST_PARTY_SURFACES: "booking-admin,unknown-surface",
      }),
    ).toThrow("AUTH_FIRST_PARTY_SURFACES contains unsupported surfaces: unknown-surface");
  });

  it("requires secure cookies for enabled HTTPS first-party surfaces", () => {
    expect(() =>
      loadConfig({
        ...completeAuthSessionEnv,
        AUTH_COOKIE_SECURE: "false",
        AUTH_FIRST_PARTY_SURFACES: "booking-admin",
      }),
    ).toThrow("AUTH_COOKIE_SECURE must be true for HTTPS first-party surfaces: booking-admin");
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

  it("enables replacement-pricing quote acceptance unless the kill switch is off", () => {
    expect(loadConfig({}).replacementPricingAcceptanceEnabled).toBe(true);
    expect(
      loadConfig({ REPLACEMENT_PRICING_ACCEPTANCE_ENABLED: "false" })
        .replacementPricingAcceptanceEnabled,
    ).toBe(false);
    expect(() => loadConfig({ REPLACEMENT_PRICING_ACCEPTANCE_ENABLED: "test-hotel" })).toThrow(
      "REPLACEMENT_PRICING_ACCEPTANCE_ENABLED must be true or false",
    );
  });

  it("keeps card quote acceptance off unless explicitly enabled", () => {
    expect(loadConfig({}).replacementPricingCardAcceptanceEnabled).toBe(false);
    expect(
      loadConfig({ REPLACEMENT_PRICING_CARD_ACCEPTANCE_ENABLED: "true" })
        .replacementPricingCardAcceptanceEnabled,
    ).toBe(true);
  });

  it("keeps deposit quote acceptance off unless explicitly enabled (VAY-2205)", () => {
    expect(loadConfig({}).replacementPricingDepositAcceptanceEnabled).toBe(false);
    expect(
      loadConfig({ REPLACEMENT_PRICING_DEPOSIT_ACCEPTANCE_ENABLED: "true" })
        .replacementPricingDepositAcceptanceEnabled,
    ).toBe(true);
  });

  it("keeps bank-transfer and PayPal quote acceptance off unless explicitly enabled", () => {
    expect(loadConfig({}).replacementPricingManualPaymentAcceptanceEnabled).toBe(false);
    expect(
      loadConfig({ REPLACEMENT_PRICING_MANUAL_PAYMENT_ACCEPTANCE_ENABLED: "true" })
        .replacementPricingManualPaymentAcceptanceEnabled,
    ).toBe(true);
  });

  it("keeps PayPal out of manual payment acceptance unless explicitly enabled (VAY-2139)", () => {
    expect(loadConfig({}).replacementPricingPaypalAcceptanceEnabled).toBe(false);
    expect(
      loadConfig({ REPLACEMENT_PRICING_MANUAL_PAYMENT_ACCEPTANCE_ENABLED: "true" })
        .replacementPricingPaypalAcceptanceEnabled,
    ).toBe(false);
    expect(
      loadConfig({ REPLACEMENT_PRICING_PAYPAL_ACCEPTANCE_ENABLED: "true" })
        .replacementPricingPaypalAcceptanceEnabled,
    ).toBe(true);
  });

  it("lists the manual payment methods the booking page takes (VAY-2139)", () => {
    const kms = { currentKeyArn: "key", allowedKeyArns: ["key"], region: "eu-west-1" };
    const methods = (
      manual: boolean,
      paypal: boolean,
      bankBinding = true,
      financeSource: "target" | "legacy" = "target",
    ) =>
      replacementPricingManualPaymentMethods({
        replacementPricingManualPaymentAcceptanceEnabled: manual,
        replacementPricingPaypalAcceptanceEnabled: paypal,
        financeSource,
        financeBankTransferKms: bankBinding ? kms : undefined,
      });
    expect(methods(false, true)).toEqual([]);
    expect(methods(true, false)).toEqual(["bank_transfer"]);
    expect(methods(true, true)).toEqual(["bank_transfer", "paypal"]);
    // Without the bank-details binding there is no bank transfer to take.
    expect(methods(true, false, false)).toEqual([]);
    expect(methods(true, true, false)).toEqual(["paypal"]);
    expect(methods(true, false, true, "legacy")).toEqual([]);
  });

  it("keeps the hotel first run (VAY-2247) unmounted unless explicitly enabled", () => {
    expect(loadConfig({}).hotelFirstRunEnabled).toBe(false);
    expect(loadConfig({ HOTEL_FIRST_RUN_ENABLED: "true" }).hotelFirstRunEnabled).toBe(true);
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
      stripeConnectSecret: undefined,
      xenditSecret: undefined,
      channexSecret: undefined,
      resendSecret: undefined,
      stripeMode: "observe_only",
      stripeConnectMode: "observe_only",
      xenditMode: "observe_only",
      channexMode: "observe_only",
    });
  });

  it("loads provider webhook secrets and per-provider intake modes", () => {
    const config = loadConfig({
      STRIPE_WEBHOOK_SECRET: "stripe-secret",
      STRIPE_CONNECT_WEBHOOK_SECRET: "stripe-connect-secret",
      XENDIT_WEBHOOK_SECRET: "xendit-secret",
      CHANNEX_WEBHOOK_SECRET: "channex-secret",
      RESEND_WEBHOOK_SECRET: "resend-secret",
      STRIPE_WEBHOOK_INTAKE_MODE: "mutating",
      STRIPE_CONNECT_WEBHOOK_INTAKE_MODE: "ack_only_with_receipt",
      XENDIT_WEBHOOK_INTAKE_MODE: "ack_only_with_receipt",
      CHANNEX_WEBHOOK_INTAKE_MODE: "observe_only",
      XENDIT_SECRET_KEY: "xendit-api-secret",
    });

    expect(config.providerWebhooks).toEqual({
      stripeSecret: "stripe-secret",
      stripeConnectSecret: "stripe-connect-secret",
      xenditSecret: "xendit-secret",
      channexSecret: "channex-secret",
      resendSecret: "resend-secret",
      stripeMode: "mutating",
      stripeConnectMode: "ack_only_with_receipt",
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

  it("requires durable media whenever the target database and auth make the server hotel-capable", () => {
    expect(loadConfig(completeCreatorMarketplaceEnv).platformMediaServing).toBeDefined();
    expect(() =>
      loadConfig({
        ...completeCreatorMarketplaceEnv,
        PLATFORM_MEDIA_BUCKET: undefined,
        PLATFORM_MEDIA_CDN_BASE_URL: undefined,
        PLATFORM_MEDIA_CDN_ORIGIN_HOST: undefined,
      }),
    ).toThrow(
      "Target database with complete auth requires complete PLATFORM_MEDIA_* config because hotel profile photos are required",
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

  it("loads identity privacy allowed origins", () => {
    expect(
      loadConfig({
        IDENTITY_PRIVACY_ALLOWED_ORIGINS:
          "https://admin.booking.localhost, https://admin.localhost,",
      }).identityPrivacyAllowedOrigins,
    ).toEqual(["https://admin.booking.localhost", "https://admin.localhost"]);
    // The platform renamed the old Marketplace variable (VAY-2302); it is no longer read.
    expect(
      loadConfig({
        MARKETPLACE_DISCOVERY_ALLOWED_ORIGINS: "https://admin.localhost",
      }).identityPrivacyAllowedOrigins,
    ).toEqual([]);
  });

  it("keeps the contact form origins apart from the identity privacy origins", () => {
    // VAY-2286: production sets CONTACT_INTAKE_ALLOWED_ORIGINS=https://vayada.com.
    expect(
      loadConfig({ CONTACT_INTAKE_ALLOWED_ORIGINS: "https://vayada.com, " })
        .contactIntakeAllowedOrigins,
    ).toEqual(["https://vayada.com"]);
    expect(loadConfig({}).contactIntakeAllowedOrigins).toEqual([
      "https://landing.localhost",
      "http://localhost:3006",
    ]);
    expect(
      loadConfig({ IDENTITY_PRIVACY_ALLOWED_ORIGINS: "https://admin.localhost" })
        .contactIntakeAllowedOrigins,
    ).not.toContain("https://admin.localhost");
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

  it("keeps the retired-media purge off unless it is switched on with the CDN and media config (VAY-2272)", () => {
    const media = {
      PLATFORM_MEDIA_BUCKET: "vayada-media-staging",
      PLATFORM_MEDIA_CDN_BASE_URL: "https://cdn.staging.vayada.com",
      PLATFORM_MEDIA_CDN_ORIGIN_HOST: "vayada-media-staging.s3.us-east-1.amazonaws.com",
    };
    const runtime = completeCreatorMarketplaceEnv;
    const distribution = { PLATFORM_MEDIA_CDN_DISTRIBUTION_ID: "E2EXAMPLE12345" };
    const on = { PLATFORM_MEDIA_RETIRED_PURGE_ENABLED: "true" };

    expect(loadConfig({ ...media, ...distribution }).platformMediaRetiredPurge).toBeUndefined();
    expect(loadConfig({ ...runtime, ...distribution, ...on }).platformMediaRetiredPurge).toEqual({
      cdnDistributionId: "E2EXAMPLE12345",
    });
    expect(
      loadConfig({ ...runtime, ...distribution, ...on, API_BACKGROUND_WORKERS_ENABLED: "false" })
        .platformMediaRetiredPurge,
    ).toEqual({ cdnDistributionId: "E2EXAMPLE12345" });
    expect(() => loadConfig({ ...media, ...on })).toThrow("PLATFORM_MEDIA_CDN_DISTRIBUTION_ID");
    expect(() => loadConfig({ ...distribution, ...on })).toThrow(
      "complete PLATFORM_MEDIA_* config",
    );
    expect(() => loadConfig({ ...media, ...distribution, ...on })).toThrow(
      "TARGET_DATABASE_URL and complete auth config",
    );
    expect(() =>
      loadConfig({ ...runtime, ...distribution, ...on, PLATFORM_MEDIA_CLEANUP_ENABLED: "false" }),
    ).toThrow("PLATFORM_MEDIA_CLEANUP_ENABLED must stay on");
  });

  it("runs the calendar auto-open scheduler hourly unless switched off", () => {
    expect(loadConfig({})).toMatchObject({
      pmsCalendarAutoOpenSchedulerEnabled: true,
      pmsCalendarAutoOpenSchedulerIntervalMs: 60 * 60 * 1000,
    });
    expect(
      loadConfig({
        PMS_CALENDAR_AUTO_OPEN_SCHEDULER_ENABLED: "false",
        PMS_CALENDAR_AUTO_OPEN_SCHEDULER_INTERVAL_MS: "900000",
      }),
    ).toMatchObject({
      pmsCalendarAutoOpenSchedulerEnabled: false,
      pmsCalendarAutoOpenSchedulerIntervalMs: 900_000,
    });
    expect(() => loadConfig({ PMS_CALENDAR_AUTO_OPEN_SCHEDULER_INTERVAL_MS: "0" })).toThrow(
      "PMS_CALENDAR_AUTO_OPEN_SCHEDULER_INTERVAL_MS must be a positive integer",
    );
    expect(() =>
      loadConfig({ PMS_CALENDAR_AUTO_OPEN_SCHEDULER_INTERVAL_MS: "2147483648" }),
    ).toThrow("PMS_CALENDAR_AUTO_OPEN_SCHEDULER_INTERVAL_MS must not exceed 2147483647");
    expect(() => loadConfig({ PMS_CALENDAR_AUTO_OPEN_SCHEDULER_INTERVAL_MS: "59999" })).toThrow(
      "PMS_CALENDAR_AUTO_OPEN_SCHEDULER_INTERVAL_MS must be at least 60000",
    );
  });

  it("checks published pricing freshness hourly unless switched off", () => {
    expect(loadConfig({})).toMatchObject({
      pricingPublicationFreshnessCheckEnabled: true,
      pricingPublicationFreshnessIntervalMs: 60 * 60 * 1000,
    });
    expect(
      loadConfig({
        PRICING_PUBLICATION_FRESHNESS_CHECK_ENABLED: "false",
        PRICING_PUBLICATION_FRESHNESS_INTERVAL_MS: "1800000",
      }),
    ).toMatchObject({
      pricingPublicationFreshnessCheckEnabled: false,
      pricingPublicationFreshnessIntervalMs: 1_800_000,
    });
    expect(() => loadConfig({ PRICING_PUBLICATION_FRESHNESS_INTERVAL_MS: "599999" })).toThrow(
      "PRICING_PUBLICATION_FRESHNESS_INTERVAL_MS must be at least 600000",
    );
    expect(loadConfig({}).pricingPublicationFreshnessAlertEmail).toBeUndefined();
    const email = { RESEND_API_KEY: "test-key", BOOKING_EMAIL_FROM: "sender@example.test" };
    expect(
      loadConfig({ ...email, PRICING_PUBLICATION_FRESHNESS_ALERT_EMAIL: " ops@example.test " }),
    ).toMatchObject({ pricingPublicationFreshnessAlertEmail: "ops@example.test" });
    expect(() =>
      loadConfig({
        ...email,
        PRICING_PUBLICATION_FRESHNESS_ALERT_EMAIL: "a@example.test,b@example.test",
      }),
    ).toThrow("PRICING_PUBLICATION_FRESHNESS_ALERT_EMAIL must be one email address");
    expect(() =>
      loadConfig({ PRICING_PUBLICATION_FRESHNESS_ALERT_EMAIL: "ops@example.test" }),
    ).toThrow(
      "PRICING_PUBLICATION_FRESHNESS_ALERT_EMAIL requires RESEND_API_KEY and BOOKING_EMAIL_FROM",
    );
  });

  it("re-publishes prices after payment changes every five minutes unless switched off (VAY-2304)", () => {
    expect(loadConfig({})).toMatchObject({
      pricingPaymentRepublishEnabled: true,
      pricingPaymentRepublishIntervalMs: 5 * 60 * 1000,
    });
    expect(
      loadConfig({
        PRICING_PAYMENT_REPUBLISH_ENABLED: "false",
        PRICING_PAYMENT_REPUBLISH_INTERVAL_MS: "60000",
      }),
    ).toMatchObject({
      pricingPaymentRepublishEnabled: false,
      pricingPaymentRepublishIntervalMs: 60_000,
    });
    expect(() => loadConfig({ PRICING_PAYMENT_REPUBLISH_INTERVAL_MS: "59999" })).toThrow(
      "PRICING_PAYMENT_REPUBLISH_INTERVAL_MS must be at least 60000",
    );
  });

  it("reads the contact notification recipient (VAY-2286)", () => {
    const email = { RESEND_API_KEY: "test-key", BOOKING_EMAIL_FROM: "sender@example.test" };
    expect(loadConfig(email).contactNotificationRecipient).toBeUndefined();
    expect(
      loadConfig({ ...email, CONTACT_NOTIFICATION_RECIPIENT: " team@example.test " })
        .contactNotificationRecipient,
    ).toBe("team@example.test");
    expect(() =>
      loadConfig({ ...email, CONTACT_NOTIFICATION_RECIPIENT: "Team <team@example.test>" }),
    ).toThrow("CONTACT_NOTIFICATION_RECIPIENT must be one email address");
    expect(() => loadConfig({ CONTACT_NOTIFICATION_RECIPIENT: "team@example.test" })).toThrow(
      "CONTACT_NOTIFICATION_RECIPIENT requires RESEND_API_KEY and BOOKING_EMAIL_FROM",
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

  it("configures and can disable booking web event retention", () => {
    expect(loadConfig({})).toMatchObject({
      bookingWebEventRetentionEnabled: true,
      bookingWebEventRetentionIntervalMs: 24 * 60 * 60 * 1000,
      bookingWebEventRetentionBatchSize: 1_000,
    });
    expect(
      loadConfig({
        BOOKING_WEB_EVENT_RETENTION_ENABLED: "false",
        BOOKING_WEB_EVENT_RETENTION_INTERVAL_MS: "60000",
        BOOKING_WEB_EVENT_RETENTION_BATCH_SIZE: "25",
      }),
    ).toMatchObject({
      bookingWebEventRetentionEnabled: false,
      bookingWebEventRetentionIntervalMs: 60_000,
      bookingWebEventRetentionBatchSize: 25,
    });
    expect(() => loadConfig({ BOOKING_WEB_EVENT_RETENTION_BATCH_SIZE: "0" })).toThrow(
      "BOOKING_WEB_EVENT_RETENTION_BATCH_SIZE must be a positive integer",
    );
    expect(() => loadConfig({ BOOKING_WEB_EVENT_RETENTION_INTERVAL_MS: "2147483648" })).toThrow(
      "BOOKING_WEB_EVENT_RETENTION_INTERVAL_MS must not exceed 2147483647",
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

describe("Finance export worker boundary config", () => {
  const env = {
    ...financeFolioKmsEnv,
    API_RUNTIME: "next",
    PUBLIC_HOTEL_PROFILE_SOURCE: "target",
    PMS_OPERATIONS_SOURCE: "disabled",
    FINANCE_SOURCE: "target",
    TARGET_DATABASE_URL: "postgresql://api:fixture@localhost/target",
    PLATFORM_MEDIA_BUCKET: "vayada-media-test",
    PLATFORM_MEDIA_CDN_BASE_URL: "https://cdn.test.vayada.com",
    PLATFORM_MEDIA_CDN_ORIGIN_HOST: "vayada-media-test.s3.eu-west-1.amazonaws.com",
    FINANCE_EXPORT_WORKER_ENABLED: "true",
    FINANCE_EXPORT_WORKER_DATABASE_URL:
      "postgresql://vayada_next_finance_export_worker:fixture@localhost/target?sslmode=require",
    FINANCE_EXPORT_WORKER_PROPERTY_ID: "20450000-0000-4000-8000-000000000001",
    FINANCE_EXPORT_WORKER_EXPORT_ID: "20450000-0000-4000-8000-000000000002",
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
      databaseUrl: `${env.FINANCE_EXPORT_WORKER_DATABASE_URL}&uselibpqcompat=true`,
      propertyId: env.FINANCE_EXPORT_WORKER_PROPERTY_ID,
      exportId: env.FINANCE_EXPORT_WORKER_EXPORT_ID,
    });
    for (const overrides of [
      { FINANCE_EXPORT_WORKER_DATABASE_URL: "" },
      { FINANCE_EXPORT_WORKER_PROPERTY_ID: "" },
      { FINANCE_EXPORT_WORKER_EXPORT_ID: "" },
      { FINANCE_EXPORT_WORKER_EXPORT_ID: "not-a-uuid" },
      { API_RUNTIME: "legacy" },
      { API_BACKGROUND_WORKERS_ENABLED: "false" },
      { FINANCE_SOURCE: "legacy" },
      { FINANCE_FOLIO_RECIPIENT_KMS_CURRENT_KEY_ARN: undefined },
      { PLATFORM_MEDIA_BUCKET: undefined },
      { FINANCE_EXPORT_WORKER_DATABASE_URL: env.TARGET_DATABASE_URL },
      {
        FINANCE_EXPORT_WORKER_DATABASE_URL:
          "postgresql://vayada_next_finance_export_worker:fixture@localhost/target",
      },
      {
        FINANCE_EXPORT_WORKER_DATABASE_URL:
          "postgresql://vayada_next_finance_export_worker:fixture@localhost/target?sslmode=disable",
      },
      {
        FINANCE_EXPORT_WORKER_DATABASE_URL:
          "postgresql://vayada_next_finance_export_worker:fixture@localhost/target?sslmode=require&sslmode=require",
      },
      {
        FINANCE_EXPORT_WORKER_DATABASE_URL:
          "postgresql://vayada_next_finance_export_worker:fixture@localhost/target?sslmode=require&application_name=worker",
      },
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
  it("enables all-hotel processing only with a fixed cutoff and verified TLS", () => {
    const ongoing = {
      ...env,
      FINANCE_EXPORT_WORKER_PROPERTY_ID: "",
      FINANCE_EXPORT_WORKER_EXPORT_ID: "",
      FINANCE_EXPORT_WORKER_ACCEPTED_AFTER: "2026-09-25T00:00:00.000Z",
      NODE_EXTRA_CA_CERTS: "/app/rds.pem",
    };
    expect(loadConfig(ongoing).financeExportWorker).toMatchObject({
      acceptedAfter: new Date(ongoing.FINANCE_EXPORT_WORKER_ACCEPTED_AFTER),
      databaseUrl: env.FINANCE_EXPORT_WORKER_DATABASE_URL.replace(
        "sslmode=require",
        "sslmode=verify-full",
      ),
    });
    for (const changed of [
      { NODE_EXTRA_CA_CERTS: "" },
      { FINANCE_EXPORT_WORKER_ACCEPTED_AFTER: "bad" },
      { FINANCE_EXPORT_WORKER_PROPERTY_ID: env.FINANCE_EXPORT_WORKER_PROPERTY_ID },
      { FINANCE_EXPORT_WORKER_EXPORT_ID: env.FINANCE_EXPORT_WORKER_EXPORT_ID },
    ])
      expect(() => loadConfig({ ...ongoing, ...changed })).toThrow();
  });
  it("normalizes the required sslmode for the node-postgres worker pool", () => {
    expect(loadConfig(env).financeExportWorker?.databaseUrl).toContain(
      "sslmode=require&uselibpqcompat=true",
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
  it("normalizes the dedicated PostgreSQL TLS URL after validating its query keys", () => {
    expect(
      loadConfig({
        ...env,
        FINANCE_EXPENSE_WORKER_DATABASE_URL:
          env.FINANCE_EXPENSE_WORKER_DATABASE_URL + "?sslmode=require",
      }).financeExpenseWorker?.databaseUrl,
    ).toContain("sslmode=require&uselibpqcompat=true");
  });
});
