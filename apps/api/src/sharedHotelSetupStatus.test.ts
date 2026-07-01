import {
  createFakeVerifier,
  type IdentityRepository,
  type LinkedResource,
  type PermissionKey,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type { FastifyInstance } from "fastify";
import type { QueryResultRow } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { createPgSharedHotelSetupStatusRepository } from "./platform/sharedHotelSetupStatusReadModel.js";
import {
  type SharedHotelSetupEntryProduct,
  type SharedHotelSetupProductSelection,
  type SharedHotelSetupStatus,
  type SharedHotelSetupStatusRepository,
  type SharedPropertyProfile,
  type SharedPropertyProfileInput,
  type SharedProductActivation,
  type SharedSetupProperty,
} from "./routes/sharedHotelSetupStatus.js";

const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondPropertyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const unrelatedPropertyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const session: VerifiedSession = {
  workosUserId: "user_workos_hotel_owner",
  workosOrgId: "org_workos_hotel_group",
  sessionId: "session_hotel_owner",
  expiresAt: futureExpiry,
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("shared hotel setup status route", () => {
  it("returns no-property setup state for a hotel group without canonical property links", async () => {
    const calls: Array<{ organizationId: string; propertyIds: string[] }> = [];
    app = buildSharedSetupApp({
      linkedResources: [],
      repository: {
        ...unusedPropertyProfileMethods(),
        async getHotelSetupStatus(input) {
          calls.push(input);
          return { hotelGroupDisplayName: "Alpenrose Hotel Group", properties: [] };
        },
        async setPropertyProductSelections() {
          throw new Error("product selection writes are not used by this test");
        },
      },
    });

    const response = await injectJson<SharedHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/status?entryProduct=booking&returnTo=/dashboard",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.selection).toEqual({
      state: "no_property",
      selectedPropertyId: null,
    });
    expect(response.body.nextAction).toEqual({
      action: "create_property",
      reasonCodes: ["no_property"],
    });
    expect(response.body.hotelGroup.displayName).toBe("Alpenrose Hotel Group");
    expect(calls).toEqual([{ organizationId, propertyIds: [] }]);
  });

  it("auto-selects a single canonical property and routes incomplete shared profile work first", async () => {
    app = buildSharedSetupApp({
      repository: repositoryWith([
        setupProperty(propertyId, {
          sharedProfile: {
            status: "incomplete",
            completionPercent: 67,
            missingFields: ["location", "media"],
          },
        }),
      ]),
    });

    const response = await injectJson<SharedHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/status?entryProduct=pms",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.selection).toEqual({
      state: "single_property",
      selectedPropertyId: propertyId,
    });
    expect(response.body.nextAction).toEqual({
      action: "complete_shared_profile",
      propertyId,
      missingFields: ["location", "media"],
      reasonCodes: ["shared_profile_incomplete"],
    });
  });

  it("returns multiple authorized properties without leaking unrelated repository rows", async () => {
    app = buildSharedSetupApp({
      linkedResources: [propertyLink(propertyId), propertyLink(secondPropertyId)],
      repository: repositoryWith([
        setupProperty(propertyId),
        setupProperty(unrelatedPropertyId),
        setupProperty(secondPropertyId),
      ]),
    });

    const response = await injectJson<SharedHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/status",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.selection).toEqual({
      state: "multiple_properties",
      selectedPropertyId: null,
    });
    expect(response.body.properties.map((property) => property.propertyId)).toEqual([
      propertyId,
      secondPropertyId,
    ]);
    expect(response.body.nextAction).toEqual({
      action: "select_property",
      reasonCodes: ["multiple_properties"],
    });
  });

  it("stores different selected products for different canonical properties", async () => {
    app = buildSharedSetupApp({
      linkedResources: [propertyLink(propertyId), propertyLink(secondPropertyId)],
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: statefulSelectionRepository([propertyId, secondPropertyId]),
    });

    const firstSelection = await injectJson<SharedHotelSetupProductSelection>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/products`,
      headers: { authorization: "Bearer valid-token" },
      payload: { selectedProducts: ["marketplace", "booking"] },
    });
    expect(firstSelection.statusCode).toBe(200);
    expect(firstSelection.body).toMatchObject({
      propertyId,
      selectedProducts: ["booking", "marketplace"],
    });

    const secondSelection = await injectJson<SharedHotelSetupProductSelection>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${secondPropertyId}/products`,
      headers: { authorization: "Bearer valid-token" },
      payload: { selectedProducts: ["pms"] },
    });
    expect(secondSelection.statusCode).toBe(200);
    expect(secondSelection.body).toMatchObject({
      propertyId: secondPropertyId,
      selectedProducts: ["pms"],
    });

    const status = await injectJson<SharedHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/status",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(status.statusCode).toBe(200);
    expect(
      status.body.properties.find((property) => property.propertyId === propertyId)!.products,
    ).toMatchObject({
      booking: { status: "selected_incomplete" },
      pms: { status: "not_selected" },
      marketplace: { status: "selected_incomplete" },
    });
    expect(
      status.body.properties.find((property) => property.propertyId === secondPropertyId)!.products,
    ).toMatchObject({
      booking: { status: "not_selected" },
      pms: { status: "selected_incomplete" },
      marketplace: { status: "not_selected" },
    });
  });

  it("creates the first shared property profile inside the resolved hotel group", async () => {
    const input = completeProfileInput("Alpenrose Munich");
    const calls: Array<{ organizationId: string; profile: SharedPropertyProfileInput }> = [];
    app = buildSharedSetupApp({
      linkedResources: [],
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: {
        ...unusedStatusMethods(),
        async createPropertyProfile(call) {
          calls.push(call);
          return profileResponse(propertyId, call.profile);
        },
        async getPropertyProfile() {
          throw new Error("create route must not read a property profile first");
        },
        async updatePropertyProfile() {
          throw new Error("create route must not update an existing property");
        },
      },
    });

    const response = await injectJson<SharedPropertyProfile>(app, {
      method: "POST",
      url: "/api/hotel-setup/properties",
      headers: { authorization: "Bearer valid-token" },
      payload: input,
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({
      propertyId,
      displayName: "Alpenrose Munich",
      sharedProfile: { status: "complete", completionPercent: 100, missingFields: [] },
    });
    expect(calls).toEqual([{ organizationId, profile: input }]);
  });

  it("adds another shared property profile under the same hotel group", async () => {
    const input = completeProfileInput("Alpenrose Vienna");
    app = buildSharedSetupApp({
      linkedResources: [propertyLink(propertyId)],
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: {
        ...unusedStatusMethods(),
        async createPropertyProfile({ organizationId: orgId, profile }) {
          expect(orgId).toBe(organizationId);
          expect(profile.displayName).toBe("Alpenrose Vienna");
          return profileResponse(secondPropertyId, profile);
        },
        async getPropertyProfile() {
          throw new Error("create route must not read a property profile first");
        },
        async updatePropertyProfile() {
          throw new Error("create route must not update an existing property");
        },
      },
    });

    const response = await injectJson<SharedPropertyProfile>(app, {
      method: "POST",
      url: "/api/hotel-setup/properties",
      headers: { authorization: "Bearer valid-token" },
      payload: input,
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({
      propertyId: secondPropertyId,
      displayName: "Alpenrose Vienna",
    });
  });

  it("reads and updates shared property profile basics for an owned property", async () => {
    const profiles = new Map<string, SharedPropertyProfile>([
      [propertyId, profileResponse(propertyId, incompleteProfileInput())],
    ]);
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: profileRepository(profiles),
    });

    const readResponse = await injectJson<SharedPropertyProfile>(app, {
      method: "GET",
      url: `/api/hotel-setup/properties/${propertyId}/profile`,
      headers: { authorization: "Bearer valid-token" },
    });
    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.body.sharedProfile).toMatchObject({
      status: "incomplete",
      missingFields: ["location", "website", "phone", "description", "media"],
    });

    const updateInput = completeProfileInput("Alpenrose Munich Updated");
    const updateResponse = await injectJson<SharedPropertyProfile>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/profile`,
      headers: { authorization: "Bearer valid-token" },
      payload: updateInput,
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.body).toMatchObject({
      propertyId,
      displayName: "Alpenrose Munich Updated",
      sharedProfile: { status: "complete", completionPercent: 100, missingFields: [] },
    });
    expect(profiles.get(propertyId)).toMatchObject({ displayName: "Alpenrose Munich Updated" });
  });

  it("rejects shared property profile reads and writes outside the selected hotel group", async () => {
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: {
        ...unusedStatusMethods(),
        async getPropertyProfile() {
          throw new Error("unauthorized profile read must not hit the repository");
        },
        async createPropertyProfile() {
          throw new Error("create is not used by this test");
        },
        async updatePropertyProfile() {
          throw new Error("unauthorized profile update must not hit the repository");
        },
      },
    });

    const readResponse = await injectJson<{ code: string }>(app, {
      method: "GET",
      url: `/api/hotel-setup/properties/${secondPropertyId}/profile`,
      headers: { authorization: "Bearer valid-token" },
    });
    expect(readResponse.statusCode).toBe(403);
    expect(readResponse.body.code).toBe("missing_property_resource_link");

    const updateResponse = await injectJson<{ code: string }>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${secondPropertyId}/profile`,
      headers: { authorization: "Bearer valid-token" },
      payload: completeProfileInput(),
    });
    expect(updateResponse.statusCode).toBe(403);
    expect(updateResponse.body.code).toBe("missing_property_resource_link");
  });

  it("returns field-level validation errors for shared property profile writes", async () => {
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: {
        ...unusedStatusMethods(),
        ...unusedPropertyProfileMethods(),
      },
    });

    const response = await injectJson<{ fields: Record<string, string[]> }>(app, {
      method: "POST",
      url: "/api/hotel-setup/properties",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        displayName: "",
        website: "ftp://alpenrose.example",
        location: { countryCode: "DEU", latitude: 48.1, addressPublic: "false" },
        media: [{ url: "not-a-url", mediaType: "cover" }],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(Object.keys(response.body.fields).sort()).toEqual([
      "displayName",
      "location.addressPublic",
      "location.countryCode",
      "location.latitude",
      "location.longitude",
      "media.0.mediaType",
      "media.0.url",
      "website",
    ]);
  });

  it("rejects non-object location payloads for shared property profile writes", async () => {
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: {
        ...unusedStatusMethods(),
        ...unusedPropertyProfileMethods(),
      },
    });

    const response = await injectJson<{ fields: Record<string, string[]> }>(app, {
      method: "POST",
      url: "/api/hotel-setup/properties",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        ...completeProfileInput(),
        location: "Berlin",
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body.fields).toEqual({
      location: ["location must be an object."],
    });
  });

  it("rejects non-hotel organizations in the normal hotel setup flow", async () => {
    app = buildSharedSetupApp({
      organizationKind: "creator_workspace",
      repository: {
        ...unusedPropertyProfileMethods(),
        async getHotelSetupStatus() {
          throw new Error("non-hotel organizations must not hit the repository");
        },
        async setPropertyProductSelections() {
          throw new Error("non-hotel organizations must not hit the repository");
        },
      },
    });

    const response = await injectJson<{ detail: string }>(app, {
      method: "GET",
      url: "/api/hotel-setup/status",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body.detail).toContain("hotel groups");
  });

  it("rejects an explicit propertyId that is not linked to the selected hotel group", async () => {
    app = buildSharedSetupApp({
      repository: {
        ...unusedPropertyProfileMethods(),
        async getHotelSetupStatus() {
          throw new Error("unauthorized property must not hit the repository");
        },
        async setPropertyProductSelections() {
          throw new Error("unauthorized property must not hit the repository");
        },
      },
    });

    const response = await injectJson<{ code: string }>(app, {
      method: "GET",
      url: `/api/hotel-setup/status?propertyId=${secondPropertyId}`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body.code).toBe("missing_property_resource_link");
  });

  it("rejects product selection writes for properties outside the selected hotel group", async () => {
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: {
        ...unusedPropertyProfileMethods(),
        async getHotelSetupStatus() {
          throw new Error("unauthorized property must not hit the repository");
        },
        async setPropertyProductSelections() {
          throw new Error("unauthorized property must not hit the repository");
        },
      },
    });

    const response = await injectJson<{ code: string }>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${secondPropertyId}/products`,
      headers: { authorization: "Bearer valid-token" },
      payload: { selectedProducts: ["booking", "pms"] },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body.code).toBe("missing_property_resource_link");
  });

  it("does not auto-select a stale property link when the catalog row is missing", async () => {
    app = buildSharedSetupApp({
      repository: repositoryWith([]),
    });

    const response = await injectJson<SharedHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/status",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.selection).toEqual({
      state: "no_property",
      selectedPropertyId: null,
    });
    expect(response.body.nextAction).toEqual({
      action: "create_property",
      reasonCodes: ["no_property"],
    });
  });

  it("returns 404 when an explicitly selected linked property has no catalog row", async () => {
    app = buildSharedSetupApp({
      repository: repositoryWith([]),
    });

    const response = await injectJson<{ code: string }>(app, {
      method: "GET",
      url: `/api/hotel-setup/status?propertyId=${propertyId}`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body.code).toBe("property_setup_status_not_found");
  });

  it("returns 404 before product selection writes when a linked property has no catalog row", async () => {
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: repositoryWith([]),
    });

    for (const selectedProducts of [[], ["booking"]] as const) {
      const response = await injectJson<{ code: string }>(app, {
        method: "PUT",
        url: `/api/hotel-setup/properties/${propertyId}/products`,
        headers: { authorization: "Bearer valid-token" },
        payload: { selectedProducts },
      });

      expect(response.statusCode).toBe(404);
      expect(response.body.code).toBe("property_setup_status_not_found");
    }
  });

  it("keeps complete shared profile separate from incomplete Marketplace activation", async () => {
    app = buildSharedSetupApp({
      repository: repositoryWith([
        setupProperty(propertyId, {
          products: {
            booking: activation("booking", "active"),
            pms: activation("pms", "not_selected"),
            marketplace: activation("marketplace", "selected_incomplete", [
              "creatorPitch",
              "collaborationOffer",
              "creatorRequirements",
              "marketplaceListing",
            ]),
          },
        }),
      ]),
    });

    const response = await injectJson<SharedHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/status?entryProduct=marketplace&returnTo=/marketplace",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.properties[0]!.sharedProfile).toMatchObject({
      status: "complete",
      missingFields: [],
    });
    expect(response.body.nextAction).toEqual({
      action: "complete_product_activation",
      propertyId,
      product: "marketplace",
      missingSteps: [
        "creatorPitch",
        "collaborationOffer",
        "creatorRequirements",
        "marketplaceListing",
      ],
      reasonCodes: ["entry_product_activation_incomplete"],
    });
  });

  it("preserves status-specific activation reasons in product next actions", async () => {
    app = buildSharedSetupApp({
      repository: repositoryWith([
        setupProperty(propertyId, {
          products: {
            booking: activation("booking", "suspended", [], ["booking_suspended"]),
            pms: activation("pms", "not_selected"),
            marketplace: activation("marketplace", "not_selected"),
          },
        }),
      ]),
    });

    const entryResponse = await injectJson<SharedHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/status?entryProduct=booking",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(entryResponse.statusCode).toBe(200);
    expect(entryResponse.body.nextAction).toEqual({
      action: "complete_product_activation",
      propertyId,
      product: "booking",
      missingSteps: [],
      reasonCodes: ["booking_suspended"],
    });

    const defaultResponse = await injectJson<SharedHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/status",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(defaultResponse.statusCode).toBe(200);
    expect(defaultResponse.body.nextAction).toEqual({
      action: "complete_product_activation",
      propertyId,
      product: "booking",
      missingSteps: [],
      reasonCodes: ["booking_suspended"],
    });
  });

  it("lets Booking, PMS, and Marketplace call the same endpoint after org resolution", async () => {
    app = buildSharedSetupApp({
      repository: repositoryWith([
        setupProperty(propertyId, {
          products: {
            booking: activation("booking", "active"),
            pms: activation("pms", "active"),
            marketplace: activation("marketplace", "active"),
          },
        }),
      ]),
    });

    for (const entryProduct of ["booking", "pms", "marketplace"] as const) {
      const response = await injectJson<SharedHotelSetupStatus>(app, {
        method: "GET",
        url: `/api/hotel-setup/status?entryProduct=${entryProduct}`,
        headers: { authorization: "Bearer valid-token" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body.nextAction).toMatchObject({
        action: "enter_product",
        product: entryProduct,
      });
    }
  });

  it("queries target hotel catalog and product tables for authorized canonical property ids", async () => {
    const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
      if (text.includes("FROM identity.organizations")) {
        return { rows: [{ displayName: "Alpenrose Hotel Group" }] };
      }
      return {
        rows: [
          {
            propertyId,
            publicId: "alpenrose-munich",
            displayName: "Alpenrose Munich",
            profileStatus: "complete",
            location: { city: "Munich", countryCode: "DE" },
            descriptions: { shortDescription: "City hotel" },
            media: [{ url: "https://example.test/photo.jpg" }],
            publicContacts: [
              { type: "website", value: "https://alpenrose.example" },
              { type: "phone", value: "+49 123" },
            ],
            bookingSelected: true,
            bookingSelectionUpdatedAt: "2026-06-30T07:59:00.000Z",
            hasBookingSettings: true,
            bookingEntitlementActive: true,
            bookingEntitlementSuspended: false,
            bookingSettingsUpdatedAt: "2026-06-30T08:00:00.000Z",
            bookabilityStatus: "public",
            bookabilityFreshnessStatus: "fresh",
            bookabilityUpdatedAt: "2026-06-30T08:01:00.000Z",
            paymentsEnabled: true,
            paymentSettingsUpdatedAt: "2026-06-30T08:02:00.000Z",
            pmsSelected: true,
            pmsSelectionUpdatedAt: "2026-06-30T07:59:00.000Z",
            pmsEntitlementActive: true,
            pmsEntitlementSuspended: false,
            pmsRoomTypeCount: 1,
            pmsRoomUpdatedAt: "2026-06-30T08:03:00.000Z",
            pmsRoomCount: 3,
            pmsRatePlanCount: 1,
            pmsRateUpdatedAt: "2026-06-30T08:04:00.000Z",
            marketplaceSelected: true,
            marketplaceSelectionUpdatedAt: "2026-06-30T07:59:00.000Z",
            marketplaceEntitlementActive: false,
            marketplaceEntitlementSuspended: false,
            marketplaceProfileStatus: "pending",
            marketplaceProfileComplete: true,
            marketplaceProfileUpdatedAt: "2026-06-30T08:05:00.000Z",
            marketplaceListingCount: 0,
            marketplaceVerifiedListingCount: 0,
            marketplaceListingUpdatedAt: null,
            marketplaceOfferingCount: 0,
            marketplaceOfferingUpdatedAt: null,
            marketplaceRequirementCount: 0,
            marketplaceRequirementUpdatedAt: null,
          },
        ],
      };
    });
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        query: async <T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await query(text, values);
          return { rows: result.rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    await expect(
      repository.getHotelSetupStatus({
        organizationId,
        propertyIds: [propertyId],
      }),
    ).resolves.toMatchObject({
      hotelGroupDisplayName: "Alpenrose Hotel Group",
      properties: [
        {
          propertyId,
          sharedProfile: { status: "complete", completionPercent: 100, missingFields: [] },
          products: {
            booking: { status: "active" },
            pms: { status: "active" },
            marketplace: {
              status: "selected_incomplete",
              missingSteps: [
                "productEntitlement",
                "marketplaceListing",
                "collaborationOffer",
                "creatorRequirements",
              ],
            },
          },
        },
      ],
    });

    const setupSql = query.mock.calls[1]![0];
    expect(setupSql).toContain("FROM unnest($2::uuid[])");
    expect(setupSql).toContain("hotel_catalog.properties");
    expect(setupSql).toContain("hotel_catalog.property_product_selections");
    expect(setupSql).toContain("COALESCE(catalog_location.location, public_profile.location");
    expect(setupSql).toContain("COALESCE(catalog_media.media, '[]'::jsonb)");
    expect(setupSql).toContain("COALESCE(catalog_contacts.public_contacts, '[]'::jsonb)");
    expect(setupSql).not.toContain("COALESCE(catalog_media.media, public_profile.media");
    expect(setupSql).not.toContain(
      "COALESCE(catalog_contacts.public_contacts, public_profile.public_contacts",
    );
    expect(setupSql).toContain("AND media.source_system = 'platform'");
    expect(setupSql).toContain("AND contact.source_system = 'platform'");
    expect(setupSql).not.toContain("property_source_links");
    expect(
      setupSql.match(
        /bool_or\(\s*status = 'suspended'\s*AND \(starts_at IS NULL OR starts_at <= now\(\)\)\s*AND \(expires_at IS NULL OR expires_at > now\(\)\)\s*\) AS suspended/g,
      ),
    ).toHaveLength(3);
    expect(query.mock.calls[1]![1]).toEqual([organizationId, [propertyId]]);
  });

  it("treats public WhatsApp contacts as satisfying shared profile phone completion", async () => {
    const query = vi.fn(async (text: string, _values?: readonly unknown[]) => {
      if (text.includes("FROM identity.organizations")) {
        return { rows: [{ displayName: "Alpenrose Hotel Group" }] };
      }
      return {
        rows: [
          {
            propertyId,
            publicId: "alpenrose-munich",
            displayName: "Alpenrose Munich",
            profileStatus: "complete",
            location: { city: "Munich", countryCode: "DE" },
            descriptions: { shortDescription: "City hotel" },
            media: [{ url: "https://example.test/photo.jpg" }],
            publicContacts: [
              { type: "website", value: "https://alpenrose.example" },
              { type: "whatsapp", value: "+49 123" },
            ],
          },
        ],
      };
    });
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        query: async <T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await query(text, values);
          return { rows: result.rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    const status = await repository.getHotelSetupStatus({
      organizationId,
      propertyIds: [propertyId],
    });

    expect(status.properties[0]!.sharedProfile).toEqual({
      status: "complete",
      completionPercent: 100,
      missingFields: [],
    });
  });

  it("computes shared profile completion from canonical property profile data", async () => {
    const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({
      rows: [
        profileRow({
          profileStatus: "complete",
          phone: null,
          media: [],
        }),
      ],
    }));
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        query: async <T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await query(text, values);
          return { rows: result.rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    const profile = await repository.getPropertyProfile({ organizationId, propertyId });

    expect(profile).toMatchObject({
      propertyId,
      sharedProfile: {
        status: "incomplete",
        completionPercent: 67,
        missingFields: ["phone", "media"],
      },
    });
    const sql = query.mock.calls[0]![0];
    expect(sql).toContain("JOIN identity.organization_resource_links link");
    expect(sql).toContain("link.product = 'hotel_catalog'");
    expect(sql).toContain("link.resource_type = 'property'");
    expect(sql).toContain("WHERE channel_type = 'whatsapp'");
    expect(sql).toContain("channel_type IN ('website', 'phone', 'whatsapp')");
    expect(sql).toContain("AND media.source_system = 'platform'");
    expect(sql).toContain("AND source_system = 'platform'");
    expect(sql).not.toContain("property_source_links");
    expect(query.mock.calls[0]![1]).toEqual([organizationId, propertyId]);
  });

  it("normalizes nullable display names when reading shared property profiles", async () => {
    const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({
      rows: [profileRow({ displayName: null })],
    }));
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        query: async <T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await query(text, values);
          return { rows: result.rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    const profile = await repository.getPropertyProfile({ organizationId, propertyId });

    expect(profile).toMatchObject({
      displayName: "",
      sharedProfile: {
        status: "incomplete",
        missingFields: ["displayName"],
      },
    });
  });

  it("creates shared property profiles with a canonical resource link but no organization insert", async () => {
    const query = vi.fn(async (text: string, _values?: readonly unknown[]) => {
      if (text.includes("INSERT INTO hotel_catalog.properties")) {
        return { rows: [{ propertyId }] };
      }
      return { rows: [profileRow()] };
    });
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        query: async <T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await query(text, values);
          return { rows: result.rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    await expect(
      repository.createPropertyProfile({
        organizationId,
        profile: completeProfileInput(),
      }),
    ).resolves.toMatchObject({
      propertyId,
      sharedProfile: { status: "complete" },
    });

    const createSql = query.mock.calls[0]![0];
    expect(createSql).toContain("INSERT INTO hotel_catalog.properties");
    expect(createSql).toContain("INSERT INTO identity.organization_resource_links");
    expect(createSql).toContain("'hotel_catalog'");
    expect(createSql).toContain("'property'");
    expect(createSql).toContain("AND contact.source_system = 'platform'");
    expect(createSql).toContain("AND media.source_system = 'platform'");
    expect(createSql).not.toContain("INSERT INTO identity.organizations");
    expect(createSql).not.toContain("property_source_links");
    expect(query.mock.calls[0]![1]).toMatchObject([
      organizationId,
      expect.objectContaining({ display_name: "Alpenrose Munich" }),
      "complete",
      [],
    ]);
  });

  it("updates shared property profiles only through an existing canonical resource link", async () => {
    const query = vi.fn(async (text: string, _values?: readonly unknown[]) => {
      if (text.includes("UPDATE hotel_catalog.properties")) {
        return { rows: [{ propertyId }] };
      }
      return { rows: [profileRow({ displayName: "Alpenrose Munich Updated" })] };
    });
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        query: async <T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await query(text, values);
          return { rows: result.rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    await expect(
      repository.updatePropertyProfile({
        organizationId,
        propertyId,
        profile: completeProfileInput("Alpenrose Munich Updated"),
      }),
    ).resolves.toMatchObject({
      propertyId,
      displayName: "Alpenrose Munich Updated",
    });

    const updateSql = query.mock.calls[0]![0];
    expect(updateSql).toContain("JOIN identity.organization_resource_links link");
    expect(updateSql).toContain("UPDATE hotel_catalog.properties");
    expect(updateSql).toContain("AND contact.source_system = 'platform'");
    expect(updateSql).toContain("AND media.source_system = 'platform'");
    expect(updateSql).not.toContain("INSERT INTO identity.organization_resource_links");
    expect(updateSql).not.toContain("property_source_links");
    expect(query.mock.calls[0]![1]).toMatchObject([
      organizationId,
      propertyId,
      expect.objectContaining({ display_name: "Alpenrose Munich Updated" }),
      "complete",
      [],
    ]);
  });

  it("requires active product entitlements before marking selected products active", async () => {
    const query = vi.fn(async (text: string, _values?: readonly unknown[]) => {
      if (text.includes("FROM identity.organizations")) {
        return { rows: [{ displayName: "Alpenrose Hotel Group" }] };
      }
      return {
        rows: [
          {
            propertyId,
            publicId: "alpenrose-munich",
            displayName: "Alpenrose Munich",
            profileStatus: "complete",
            location: { city: "Munich", countryCode: "DE" },
            descriptions: { shortDescription: "City hotel" },
            media: [{ url: "https://example.test/photo.jpg" }],
            publicContacts: [
              { type: "website", value: "https://alpenrose.example" },
              { type: "phone", value: "+49 123" },
            ],
            bookingSelected: true,
            bookingSelectionUpdatedAt: "2026-06-30T07:59:00.000Z",
            hasBookingSettings: true,
            bookingEntitlementActive: false,
            bookingEntitlementSuspended: false,
            bookingSettingsUpdatedAt: "2026-06-30T08:00:00.000Z",
            bookabilityStatus: "public",
            bookabilityFreshnessStatus: "fresh",
            bookabilityUpdatedAt: "2026-06-30T08:01:00.000Z",
            paymentsEnabled: true,
            paymentSettingsUpdatedAt: "2026-06-30T08:02:00.000Z",
            pmsSelected: true,
            pmsSelectionUpdatedAt: "2026-06-30T07:59:00.000Z",
            pmsEntitlementActive: false,
            pmsEntitlementSuspended: false,
            pmsRoomTypeCount: 1,
            pmsRoomUpdatedAt: "2026-06-30T08:03:00.000Z",
            pmsRoomCount: 1,
            pmsRatePlanCount: 1,
            pmsRateUpdatedAt: "2026-06-30T08:04:00.000Z",
            marketplaceSelected: true,
            marketplaceSelectionUpdatedAt: "2026-06-30T07:59:00.000Z",
            marketplaceEntitlementActive: false,
            marketplaceEntitlementSuspended: false,
            marketplaceProfileStatus: "verified",
            marketplaceProfileComplete: true,
            marketplaceListingCount: 1,
            marketplaceVerifiedListingCount: 1,
            marketplaceOfferingCount: 1,
            marketplaceRequirementCount: 1,
          },
        ],
      };
    });
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        query: async <T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await query(text, values);
          return { rows: result.rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    const status = await repository.getHotelSetupStatus({
      organizationId,
      propertyIds: [propertyId],
    });

    expect(status.properties[0]!.products.booking).toMatchObject({
      status: "selected_incomplete",
      missingSteps: ["productEntitlement"],
      statusReasons: ["booking_activation_incomplete"],
    });
    expect(status.properties[0]!.products.pms).toMatchObject({
      status: "selected_incomplete",
      missingSteps: ["productEntitlement"],
      statusReasons: ["pms_activation_incomplete"],
    });
    expect(status.properties[0]!.products.marketplace).toMatchObject({
      status: "selected_incomplete",
      missingSteps: ["productEntitlement"],
      statusReasons: ["marketplace_activation_incomplete"],
    });
  });

  it("returns selected products from the write CTE instead of a stale base-table snapshot", async () => {
    const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({
      rows: [
        { product: "booking", updatedAt: "2026-06-30T08:00:00.000Z" },
        { product: "marketplace", updatedAt: "2026-06-30T08:01:00.000Z" },
      ],
    }));
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        query: async <T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await query(text, values);
          return { rows: result.rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    await expect(
      repository.setPropertyProductSelections({
        organizationId,
        propertyId,
        selectedProducts: ["marketplace", "booking"],
      }),
    ).resolves.toEqual({
      propertyId,
      selectedProducts: ["booking", "marketplace"],
      updatedAt: "2026-06-30T08:01:00.000Z",
    });

    const selectionSql = query.mock.calls[0]![0];
    expect(selectionSql).toContain("FROM upserted");
    expect(selectionSql).toContain("FROM unselected");
    expect(selectionSql).toContain("WHERE FALSE");
    expect(selectionSql).not.toContain(
      "FROM hotel_catalog.property_product_selections\n    WHERE organization_id = $1::uuid",
    );
    expect(query.mock.calls[0]![1]).toEqual([
      organizationId,
      propertyId,
      ["marketplace", "booking"],
    ]);
  });

  it("does not treat product rows or entitlements as product-selection intent", async () => {
    const query = vi.fn(async (text: string, _values?: readonly unknown[]) => {
      if (text.includes("FROM identity.organizations")) {
        return { rows: [{ displayName: "Alpenrose Hotel Group" }] };
      }
      return {
        rows: [
          {
            propertyId,
            publicId: "alpenrose-munich",
            displayName: "Alpenrose Munich",
            profileStatus: "complete",
            location: { city: "Munich", countryCode: "DE" },
            descriptions: { shortDescription: "City hotel" },
            media: [{ url: "https://example.test/photo.jpg" }],
            publicContacts: [
              { type: "website", value: "https://alpenrose.example" },
              { type: "phone", value: "+49 123" },
            ],
            bookingSelected: false,
            bookingSelectionUpdatedAt: null,
            hasBookingSettings: true,
            bookingEntitlementActive: true,
            bookingEntitlementSuspended: false,
            bookabilityStatus: "public",
            bookabilityFreshnessStatus: "fresh",
            paymentsEnabled: true,
            pmsSelected: false,
            pmsSelectionUpdatedAt: null,
            pmsEntitlementActive: true,
            pmsEntitlementSuspended: false,
            pmsRoomTypeCount: 1,
            pmsRoomCount: 1,
            pmsRatePlanCount: 1,
            marketplaceSelected: false,
            marketplaceSelectionUpdatedAt: null,
            marketplaceEntitlementActive: true,
            marketplaceEntitlementSuspended: false,
            marketplaceProfileStatus: "verified",
            marketplaceProfileComplete: true,
            marketplaceListingCount: 1,
            marketplaceVerifiedListingCount: 1,
            marketplaceOfferingCount: 1,
            marketplaceRequirementCount: 1,
          },
        ],
      };
    });
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        query: async <T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await query(text, values);
          return { rows: result.rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    const status = await repository.getHotelSetupStatus({
      organizationId,
      propertyIds: [propertyId],
    });

    expect(status.properties[0]!.products).toMatchObject({
      booking: { status: "not_selected" },
      pms: { status: "not_selected" },
      marketplace: { status: "not_selected" },
    });
  });

  it("treats suspended product entitlements as suspended activation status", async () => {
    const query = vi.fn(async (text: string, _values?: readonly unknown[]) => {
      if (text.includes("FROM identity.organizations")) {
        return { rows: [{ displayName: "Alpenrose Hotel Group" }] };
      }
      return {
        rows: [
          {
            propertyId,
            publicId: "alpenrose-munich",
            displayName: "Alpenrose Munich",
            profileStatus: "complete",
            location: { city: "Munich", countryCode: "DE" },
            descriptions: { shortDescription: "City hotel" },
            media: [{ url: "https://example.test/photo.jpg" }],
            publicContacts: [
              { type: "website", value: "https://alpenrose.example" },
              { type: "phone", value: "+49 123" },
            ],
            bookingSelected: false,
            bookingSelectionUpdatedAt: null,
            hasBookingSettings: false,
            bookingEntitlementActive: false,
            bookingEntitlementSuspended: false,
            bookabilityStatus: null,
            paymentsEnabled: null,
            pmsSelected: true,
            pmsSelectionUpdatedAt: "2026-06-30T07:59:00.000Z",
            pmsEntitlementActive: true,
            pmsEntitlementSuspended: true,
            pmsEntitlementUpdatedAt: "2026-06-30T08:04:00.000Z",
            pmsRoomTypeCount: 1,
            pmsRoomCount: 3,
            pmsRatePlanCount: 1,
            pmsRateUpdatedAt: "2026-06-30T08:03:00.000Z",
            marketplaceSelected: false,
            marketplaceSelectionUpdatedAt: null,
            marketplaceEntitlementActive: false,
            marketplaceEntitlementSuspended: false,
            marketplaceProfileStatus: null,
            marketplaceProfileComplete: null,
            marketplaceListingCount: 0,
            marketplaceVerifiedListingCount: 0,
            marketplaceOfferingCount: 0,
            marketplaceRequirementCount: 0,
          },
        ],
      };
    });
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        query: async <T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await query(text, values);
          return { rows: result.rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    const status = await repository.getHotelSetupStatus({
      organizationId,
      propertyIds: [propertyId],
    });

    expect(status.properties[0]!.products.pms).toMatchObject({
      status: "suspended",
      statusReasons: ["pms_suspended"],
      updatedAt: "2026-06-30T08:04:00.000Z",
    });
  });

  it("does not close caller-owned database pools", async () => {
    const end = vi.fn(async () => undefined);
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        async query<T extends QueryResultRow = QueryResultRow>() {
          return { rows: [] as T[] };
        },
        end,
      },
    });

    await repository.close?.();

    expect(end).not.toHaveBeenCalled();
  });
});

const productOrder: readonly SharedHotelSetupEntryProduct[] = ["booking", "pms", "marketplace"];

function buildSharedSetupApp(options: {
  repository: SharedHotelSetupStatusRepository;
  permissions?: PermissionKey[];
  linkedResources?: LinkedResource[];
  organizationKind?: "hotel_group" | "creator_workspace" | "affiliate_partner" | "platform";
}): FastifyInstance {
  return buildApp({
    logger: false,
    sharedHotelSetupStatusRepository: options.repository,
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository(options),
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["hotel_catalog.setup.read"];
        },
      },
    },
  });
}

function identityRepository(options: {
  linkedResources?: LinkedResource[];
  organizationKind?: "hotel_group" | "creator_workspace" | "affiliate_partner" | "platform";
}): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return {
        userId: "user_hotel_owner",
        email: "owner@example.com",
        status: "active",
      };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId,
        workosOrgId: session.workosOrgId ?? null,
        kind: options.organizationKind ?? "hotel_group",
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "membership_hotel_owner",
        status: "active",
        roleKey: "hotel_owner",
        workosMembershipId: "om_hotel_owner",
        workosRoleSlugs: ["hotel_owner"],
      };
    },
    async findLinkedResources() {
      return options.linkedResources ?? [propertyLink(propertyId)];
    },
  };
}

function unusedStatusMethods(): Pick<
  SharedHotelSetupStatusRepository,
  "getHotelSetupStatus" | "setPropertyProductSelections"
> {
  return {
    async getHotelSetupStatus() {
      throw new Error("setup status reads are not used by this repository");
    },
    async setPropertyProductSelections() {
      throw new Error("product selection writes are not used by this repository");
    },
  };
}

function repositoryWith(properties: SharedSetupProperty[]): SharedHotelSetupStatusRepository {
  return {
    ...unusedPropertyProfileMethods(),
    async getHotelSetupStatus() {
      return { hotelGroupDisplayName: "Alpenrose Hotel Group", properties };
    },
    async setPropertyProductSelections() {
      throw new Error("product selection writes are not used by this repository");
    },
  };
}

function profileRepository(
  profiles: Map<string, SharedPropertyProfile>,
): SharedHotelSetupStatusRepository {
  return {
    ...unusedStatusMethods(),
    async getPropertyProfile({ propertyId: id }) {
      return profiles.get(id) ?? null;
    },
    async createPropertyProfile({ profile }) {
      const created = profileResponse(secondPropertyId, profile);
      profiles.set(secondPropertyId, created);
      return created;
    },
    async updatePropertyProfile({ propertyId: id, profile }) {
      if (!profiles.has(id)) return null;
      const updated = profileResponse(id, profile);
      profiles.set(id, updated);
      return updated;
    },
  };
}

function statefulSelectionRepository(propertyIds: string[]): SharedHotelSetupStatusRepository {
  const selectedByProperty = new Map<string, Set<SharedHotelSetupEntryProduct>>();

  return {
    ...unusedPropertyProfileMethods(),
    async getHotelSetupStatus() {
      return {
        hotelGroupDisplayName: "Alpenrose Hotel Group",
        properties: propertyIds.map((id) => {
          const selected = selectedByProperty.get(id) ?? new Set<SharedHotelSetupEntryProduct>();
          return setupProperty(id, {
            products: {
              booking: selected.has("booking")
                ? activation("booking", "selected_incomplete", ["productEntitlement"])
                : activation("booking", "not_selected"),
              pms: selected.has("pms")
                ? activation("pms", "selected_incomplete", ["roomTypes", "rooms", "ratePlans"])
                : activation("pms", "not_selected"),
              marketplace: selected.has("marketplace")
                ? activation("marketplace", "selected_incomplete", [
                    "creatorPitch",
                    "collaborationOffer",
                    "creatorRequirements",
                    "marketplaceListing",
                  ])
                : activation("marketplace", "not_selected"),
            },
          });
        }),
      };
    },
    async setPropertyProductSelections({ propertyId: id, selectedProducts }) {
      selectedByProperty.set(id, new Set(selectedProducts));
      return {
        propertyId: id,
        selectedProducts: productOrder.filter((product) => selectedProducts.includes(product)),
        updatedAt: "2026-06-30T08:00:00.000Z",
      };
    },
  };
}

function unusedPropertyProfileMethods(): Pick<
  SharedHotelSetupStatusRepository,
  "getPropertyProfile" | "createPropertyProfile" | "updatePropertyProfile"
> {
  return {
    async getPropertyProfile() {
      throw new Error("property profile reads are not used by this repository");
    },
    async createPropertyProfile() {
      throw new Error("property profile creates are not used by this repository");
    },
    async updatePropertyProfile() {
      throw new Error("property profile updates are not used by this repository");
    },
  };
}

function completeProfileInput(displayName = "Alpenrose Munich"): SharedPropertyProfileInput {
  return {
    displayName,
    location: {
      countryCode: "DE",
      region: "Bavaria",
      city: "Munich",
      streetAddress: "Marienplatz 1",
      postalCode: "80331",
      rawMarketplaceLocation: null,
      timezone: "Europe/Berlin",
      latitude: 48.137,
      longitude: 11.575,
      addressPublic: true,
      mapDisplayMode: "exact",
    },
    website: "https://alpenrose.example/",
    phone: "+49 123",
    shortDescription: "A city hotel in Munich.",
    longDescription: null,
    media: [
      {
        mediaType: "hero_image",
        url: "https://cdn.example/alpenrose.jpg",
        altText: "Alpenrose exterior",
        sortOrder: 0,
      },
    ],
  };
}

function incompleteProfileInput(): SharedPropertyProfileInput {
  return {
    ...completeProfileInput(),
    location: {
      countryCode: null,
      region: null,
      city: null,
      streetAddress: null,
      postalCode: null,
      rawMarketplaceLocation: null,
      timezone: null,
      latitude: null,
      longitude: null,
      addressPublic: true,
      mapDisplayMode: "hidden",
    },
    website: null,
    phone: null,
    shortDescription: null,
    longDescription: null,
    media: [],
  };
}

function profileResponse(id: string, profile: SharedPropertyProfileInput): SharedPropertyProfile {
  const missingFields = profileMissingFields(profile);
  return {
    propertyId: id,
    publicId: `property-${id.slice(0, 8)}`,
    ...profile,
    sharedProfile: {
      status: missingFields.length === 0 ? "complete" : "incomplete",
      completionPercent:
        missingFields.length === 0 ? 100 : Math.round(((6 - missingFields.length) / 6) * 100),
      missingFields,
    },
    updatedAt: "2026-06-30T08:00:00.000Z",
  };
}

function profileMissingFields(
  profile: SharedPropertyProfileInput,
): SharedPropertyProfile["sharedProfile"]["missingFields"] {
  const missing: SharedPropertyProfile["sharedProfile"]["missingFields"] = [];
  if (!nonEmpty(profile.displayName)) missing.push("displayName");
  if (
    ![
      profile.location.city,
      profile.location.countryCode,
      profile.location.rawMarketplaceLocation,
    ].some((value) => nonEmpty(value))
  ) {
    missing.push("location");
  }
  if (!nonEmpty(profile.website)) missing.push("website");
  if (!nonEmpty(profile.phone)) missing.push("phone");
  if (!nonEmpty(profile.shortDescription) && !nonEmpty(profile.longDescription)) {
    missing.push("description");
  }
  if (profile.media.length === 0) missing.push("media");
  return missing;
}

function profileRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    propertyId,
    publicId: "property-aaaaaaaa",
    displayName: "Alpenrose Munich",
    profileStatus: "complete",
    countryCode: "DE",
    region: "Bavaria",
    city: "Munich",
    streetAddress: "Marienplatz 1",
    postalCode: "80331",
    rawMarketplaceLocation: null,
    timezone: "Europe/Berlin",
    latitude: "48.137",
    longitude: "11.575",
    addressPublic: true,
    mapDisplayMode: "exact",
    shortDescription: "A city hotel in Munich.",
    longDescription: null,
    website: "https://alpenrose.example/",
    phone: "+49 123",
    media: [
      {
        mediaType: "hero_image",
        url: "https://cdn.example/alpenrose.jpg",
        altText: "Alpenrose exterior",
        sortOrder: 0,
      },
    ],
    updatedAt: "2026-06-30T08:00:00.000Z",
    ...overrides,
  };
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function setupProperty(
  id: string,
  overrides: Partial<SharedSetupProperty> = {},
): SharedSetupProperty {
  return {
    propertyId: id,
    publicId: `property-${id.slice(0, 8)}`,
    displayName: "Alpenrose Munich",
    locationSummary: "Munich, DE",
    sharedProfile: {
      status: "complete",
      completionPercent: 100,
      missingFields: [],
    },
    products: {
      booking: activation("booking", "not_selected"),
      pms: activation("pms", "not_selected"),
      marketplace: activation("marketplace", "not_selected"),
    },
    ...overrides,
  };
}

function activation<Product extends "booking" | "pms" | "marketplace">(
  product: Product,
  status: SharedProductActivation<Product>["status"],
  missingSteps: string[] = [],
  statusReasons: string[] = status === "selected_incomplete"
    ? [`${product}_activation_incomplete`]
    : [],
): SharedProductActivation<Product> {
  return {
    product,
    status,
    missingSteps,
    statusReasons,
    updatedAt: status === "not_selected" ? null : "2026-06-30T08:00:00.000Z",
  };
}

function propertyLink(resourceId: string): LinkedResource {
  return {
    product: "hotel_catalog",
    resourceType: "property",
    resourceId,
    relationship: "owner",
    status: "active",
  };
}
