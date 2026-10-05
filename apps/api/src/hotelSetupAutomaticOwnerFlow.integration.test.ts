import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import { parseUpsertPropertyPricingCurrencyCommand } from "@vayada/domain-pms";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHotelSetupCurrencyCommands } from "./hotelSetupCurrencyCommands.js";
import { createHotelSetupFeatureHubCommands } from "./hotelSetupFeatureHubCommands.js";
import { createHotelSetupLaunchSettingsCommands } from "./hotelSetupLaunchSettingsCommands.js";
import { createHotelSetupCredentialResolver } from "./hotelSetupCommandCredentials.js";
import type { SharedPropertyProfileInput } from "./routes/sharedHotelSetupStatus.js";
import { createAutomaticOwnerFlowFixture } from "./hotelSetupAutomaticOwnerFlow.fixture.js";

const databaseUrl = process.env.HOTEL_SETUP_AUTOMATIC_OWNER_FLOW_TEST_DATABASE_URL;
const rollbackRoot = process.env.HOTEL_SETUP_AUTOMATIC_ROLLBACK_PREFLIGHT_ROOT;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe.runIf(databaseUrl && rollbackRoot)("synthetic Owner automatic native setup", () => {
  it("preserves atomic Save/reload identity and restrictions through actual primary/compiled rollback proofs", async () => {
    const {
      admin,
      repository,
      organizationId,
      actorUserId,
      membershipId,
      aws,
      options,
      creation,
      proveOrganization,
      proveProperty,
      records,
      pass,
      close,
    } = await createAutomaticOwnerFlowFixture(databaseUrl!, rollbackRoot!);
    const financials = (propertyId: string) =>
      admin.query(
        `SELECT status,metadata->>'newHotelFinancialsDefault' AS marker,
      metadata->'newHotelFinancialsOwnerDisabled' AS "ownerOff" FROM identity.product_entitlements
      WHERE organization_id=$1 AND product='pms' AND entitlement_key='module:financials' AND resource_id=$2`,
        [organizationId, propertyId],
      );
    try {
      const settings = {
        defaultCurrency: "LKR",
        supportedCurrencies: ["LKR", "USD"],
        defaultLanguage: "en",
        supportedLanguages: ["en", "de"],
        instagram: "https://example.test/instagram",
        facebook: "https://example.test/facebook",
        tiktok: "",
        youtube: "",
      };
      const profile: SharedPropertyProfileInput = {
        displayName: "Synthetic Owner hotel",
        propertyType: "hotel",
        location: {
          countryCode: "LK",
          city: "Fixture city",
          streetAddress: "Fixture street 1",
          postalCode: "00000",
          timezone: "Asia/Colombo",
          latitude: null,
          longitude: null,
          localityPublic: false,
          geoPublic: false,
          mapDisplayMode: "hidden",
        },
        contacts: [
          {
            channelType: "email",
            value: "owner@fixture.invalid",
            purpose: "guest",
            isPublic: false,
          },
        ],
        initialLaunchSettings: settings,
      };
      const input = {
        organizationId,
        idempotencyKey: "synthetic-first-save",
        correlationId: "synthetic-first-save",
        profile,
        audit: {
          actorUserId,
          requestId: "synthetic-first-save",
          receivedAt: new Date().toISOString(),
        },
      };
      await expect(creation.createPropertyProfile(input)).rejects.toThrow("creation unavailable");
      expect(aws).not.toHaveBeenCalled();
      expect((await pass("organization")).receipts.map((r) => r.status)).toEqual(["provisioned"]);
      expect(proveOrganization).toHaveBeenCalledTimes(3);
      expect(records.size).toBe(1);
      // Lose the post-COMMIT profile read, then replay the same creation key. No existing-property PUT occurs.
      const originalQuery = pg.Pool.prototype.query;
      const failReload = async function (this: pg.Pool, ...args: unknown[]) {
        if (
          typeof args[0] === "string" &&
          args[0].includes('property.profile_revision AS "profileRevision"')
        ) {
          reload.mockRestore();
          throw new Error("synthetic post-COMMIT reload failure");
        }
        return (originalQuery as unknown as (...values: unknown[]) => Promise<unknown>).apply(
          this,
          args,
        );
      };
      const reload = vi.spyOn(pg.Pool.prototype, "query").mockImplementation(failReload as never);
      await expect(creation.createPropertyProfile(input)).rejects.toThrow("creation unavailable");
      const first = await creation.createPropertyProfile(input);
      const propertyId = first.propertyId;
      expect(
        (
          await admin.query(
            "SELECT id FROM hotel_catalog.properties WHERE creation_organization_id=$1",
            [organizationId],
          )
        ).rows,
      ).toEqual([{ id: propertyId }]);
      expect(await repository.getPropertyProfile({ organizationId, propertyId })).toMatchObject({
        propertyId,
        profile: { displayName: profile.displayName },
      });
      expect(
        (
          await admin.query(
            `SELECT default_currency AS currency,supported_currencies AS currencies,
        default_language AS language,supported_languages AS languages FROM booking.booking_settings WHERE property_id=$1`,
            [propertyId],
          )
        ).rows,
      ).toEqual([
        { currency: "LKR", currencies: ["LKR", "USD"], language: "en", languages: ["en", "de"] },
      ]);
      expect(
        (
          await admin.query(
            "SELECT channel_type,value FROM hotel_catalog.property_contact_channels WHERE property_id=$1 AND source_system='booking' ORDER BY channel_type",
            [propertyId],
          )
        ).rows,
      ).toEqual([
        { channel_type: "facebook", value: settings.facebook },
        { channel_type: "instagram", value: settings.instagram },
      ]);
      const reads = aws.mock.calls.length;
      await expect(
        createHotelSetupCredentialResolver(options, "launch_settings")(propertyId, organizationId),
      ).rejects.toThrow("Missing hotel setup assignment");
      expect(aws.mock.calls.length).toBe(reads);
      // Past-due base billing cannot acquire new property capabilities.
      const billingId = randomUUID();
      await admin.query(
        "INSERT INTO finance.billing_entitlements(id,organization_id,product,entitlement_key,billing_status) VALUES($1,$2,'pms','property-management','past_due')",
        [billingId, organizationId],
      );
      expect((await pass("property")).receipts.map((r) => r.status)).toEqual([
        "pending_authority",
        "pending_authority",
        "pending_authority",
      ]);
      expect(
        (
          await admin.query(
            "SELECT database_login FROM platform.hotel_setup_property_scopes WHERE property_id=$1",
            [propertyId],
          )
        ).rows,
      ).toEqual([]);
      expect(records.size).toBe(1);
      await admin.query("DELETE FROM finance.billing_entitlements WHERE id=$1", [billingId]);
      await pass("property"); // Empty-page wrap before retrying the earlier scope.
      expect((await pass("property")).receipts.map((r) => r.status)).toEqual([
        "provisioned",
        "provisioned",
        "provisioned",
      ]);
      expect(proveProperty).toHaveBeenCalledTimes(3);
      expect(records.size).toBe(4);
      expect((await financials(propertyId)).rows).toEqual([
        { status: "suspended", marker: "pending", ownerOff: null },
      ]);
      expect(
        (
          await admin.query(
            "SELECT property_id FROM pms.property_pricing_settings WHERE property_id=$1",
            [propertyId],
          )
        ).rows,
      ).toEqual([]);
      const nativeBefore = (
        await admin.query(
          "SELECT database_login,credential_role_oid,credential_secret_version FROM platform.hotel_setup_property_scopes WHERE property_id=$1 ORDER BY operation_class",
          [propertyId],
        )
      ).rows;
      await pass("property");
      await pass("property");
      expect(
        (
          await admin.query(
            "SELECT database_login,credential_role_oid,credential_secret_version FROM platform.hotel_setup_property_scopes WHERE property_id=$1 ORDER BY operation_class",
            [propertyId],
          )
        ).rows,
      ).toEqual(nativeBefore);
      expect(records.size).toBe(4);
      const context = {
        actor: {
          internalUserId: actorUserId,
          providerIdentity: { sessionId: "synthetic-session" },
        },
        selectedOrganization: { organizationId },
        audit: { requestId: "synthetic-command", receivedAt: new Date().toISOString() },
      } as RequestContext;
      expect(
        await createHotelSetupLaunchSettingsCommands(options).updateLaunchSettings(
          context,
          propertyId,
          settings,
        ),
      ).toEqual(settings);
      const currency = createHotelSetupCurrencyCommands({
        ...options,
        currencyChangeGuard: {
          async runWithCurrencyChangeGuard() {
            throw new Error("First currency must not use a change guard");
          },
        },
      });
      const command = parseUpsertPropertyPricingCurrencyCommand({
        organizationId,
        propertyId,
        currency: "LKR",
        expectedPricingCurrencyRevision: 0,
        idempotencyKey: "synthetic-first-currency",
        audit: {
          actor: { kind: "user", userId: actorUserId },
          requestId: "synthetic-first-currency",
          correlationId: null,
          requestedAt: new Date().toISOString(),
        },
      })!;
      // Organization-wide Financials suspension remains authoritative after credentials are ready.
      const globalId = randomUUID();
      await admin.query(
        "INSERT INTO identity.product_entitlements(id,organization_id,product,entitlement_key,status) VALUES($1,$2,'pms','module:financials','suspended')",
        [globalId, organizationId],
      );
      await expect(currency.upsertPropertyPricingCurrency(command)).rejects.toThrow(
        "currency command unavailable",
      );
      expect(
        (
          await admin.query(
            "SELECT property_id FROM pms.property_pricing_settings WHERE property_id=$1",
            [propertyId],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await admin.query("SELECT id FROM finance.expense_categories WHERE property_id=$1", [
            propertyId,
          ])
        ).rows,
      ).toEqual([]);
      expect((await financials(propertyId)).rows).toEqual([
        { status: "suspended", marker: "pending", ownerOff: null },
      ]);
      await admin.query("DELETE FROM identity.product_entitlements WHERE id=$1", [globalId]);
      const saved = await currency.upsertPropertyPricingCurrency(command);
      expect(saved).toMatchObject({
        ok: true,
        response: {
          outcome: "created",
          pricingCurrency: { propertyId, currency: "LKR", pricingCurrencyRevision: 1 },
        },
      });
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM finance.expense_categories WHERE property_id=$1",
            [propertyId],
          )
        ).rows,
      ).toEqual([{ count: 7 }]);
      expect((await financials(propertyId)).rows).toMatchObject([
        { status: "active", marker: "ready" },
      ]);
      const feature = createHotelSetupFeatureHubCommands(options);
      expect(await feature.updateFinancials(context, propertyId, false)).toMatchObject({
        isActive: false,
      });
      expect((await financials(propertyId)).rows).toMatchObject([
        { status: "suspended", ownerOff: true },
      ]);
      await pass("property");
      await pass("property");
      expect(await currency.upsertPropertyPricingCurrency(command)).toEqual(saved);
      expect((await financials(propertyId)).rows).toMatchObject([
        { status: "suspended", ownerOff: true },
      ]);
      expect(records.size).toBe(4);
      await admin.query(
        "UPDATE identity.organization_memberships SET status='inactive' WHERE id=$1",
        [membershipId],
      );
      const denied = await currency.upsertPropertyPricingCurrency(command);
      expect(denied).toMatchObject({ ok: false, error: { code: "setup_scope_unavailable" } });
    } finally {
      await close();
    }
  }, 30_000);
});
