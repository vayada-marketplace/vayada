import { describe, expect, expectTypeOf, it } from "vitest";

import {
  PROPERTY_SETUP_ACTIVE_RETENTION_DAYS,
  PROPERTY_SETUP_COMPLETED_RETENTION_DAYS,
  PROPERTY_SETUP_DRAFT_PII_CLASSIFICATION,
  PROPERTY_SETUP_STEP_DEFINITIONS,
  getActivePropertySetupStepIds,
  getPropertySetupBaseRevisionKeys,
  isPropertySetupBaseRevisionManifest,
  isPropertySetupLegacyCalendarBaseRevisionManifest,
  type PropertySetupBaseRevisions,
  type PropertySetupDraftPayload,
  type JsonValue,
  type SavePropertySetupDraftReceipt,
  type SavePropertySetupDraftResult,
} from "./propertySetupDraft.js";

describe("property setup draft contract", () => {
  it("accepts the guest-rule owner manifest and rejects the retired pricing bundle", () => {
    const current = {
      "booking.guest_experience": "guest-choices:11111111-1111-4111-8111-111111111111",
    };
    expect(isPropertySetupBaseRevisionManifest("guest_experience", current)).toBe(true);
    expect(
      isPropertySetupBaseRevisionManifest("guest_experience", {
        ...current,
        "pms.pricing_settings": "pricing:1",
        "pms.rate_plans": "rates:1",
        "pms.room_types": "rooms:1",
        "hotel_catalog.location": "location:1",
        "hotel_catalog.policy": "policy:1",
      }),
    ).toBe(false);
  });
  it("pins a calendar draft to the time zone, rooms and units, and still reads legacy drafts", () => {
    const current = {
      "pms.operating_calendar": "calendar:2",
      "pms.inventory": "inventory:2",
      "pms.room_units": "room-units:abc",
      "hotel_catalog.time_zone": "time-zone:def",
    };
    const legacy = {
      "pms.operating_calendar": "calendar:2",
      "pms.inventory": "inventory:2",
      "pms.room_types": "room-types:abc",
      "hotel_catalog.location": "hotel_catalog.location:property:r3",
    };
    expect(getPropertySetupBaseRevisionKeys("calendar", current)).toEqual([
      "pms.operating_calendar",
      "pms.inventory",
      "pms.room_units",
      "hotel_catalog.time_zone",
    ]);
    expect(getPropertySetupBaseRevisionKeys("calendar", legacy)).toEqual([
      "pms.operating_calendar",
      "pms.inventory",
      "pms.room_types",
      "hotel_catalog.location",
    ]);
    expect(isPropertySetupBaseRevisionManifest("calendar", legacy)).toBe(true);
    expect(isPropertySetupLegacyCalendarBaseRevisionManifest(legacy)).toBe(true);
    expect(isPropertySetupLegacyCalendarBaseRevisionManifest(current)).toBe(false);
    // Mixed or partial key sets, and the legacy calendar keys on another step, stay invalid.
    const { ["pms.room_units"]: _units, ...partial } = current;
    expect(
      isPropertySetupBaseRevisionManifest("calendar", {
        ...partial,
        "pms.room_types": "room-types:abc",
      }),
    ).toBe(false);
    expect(isPropertySetupBaseRevisionManifest("calendar", { ...current, ...legacy })).toBe(false);
    expect(isPropertySetupBaseRevisionManifest("calendar", partial)).toBe(false);
    expect(isPropertySetupBaseRevisionManifest("rooms", legacy)).toBe(false);
    expect(
      isPropertySetupBaseRevisionManifest("calendar", { ...current, "pms.inventory": "" }),
    ).toBe(false);
    expectTypeOf(legacy).toMatchTypeOf<PropertySetupBaseRevisions<"calendar">>();
    expectTypeOf(current).toMatchTypeOf<PropertySetupBaseRevisions<"calendar">>();
  });

  it("defines the approved retention, PII posture, and nine stable steps", () => {
    expect(PROPERTY_SETUP_ACTIVE_RETENTION_DAYS).toBe(90);
    expect(PROPERTY_SETUP_COMPLETED_RETENTION_DAYS).toBe(30);
    expect(PROPERTY_SETUP_DRAFT_PII_CLASSIFICATION).toBe("potential_incidental_pii");
    expect(PROPERTY_SETUP_STEP_DEFINITIONS.map(({ stepId }) => stepId)).toEqual([
      "present_hotel",
      "marketplace_preferences",
      "booking_design",
      "rooms",
      "payments",
      "pricing",
      "calendar",
      "guest_experience",
      "review",
    ]);
    expect(
      PROPERTY_SETUP_STEP_DEFINITIONS.find(({ stepId }) => stepId === "present_hotel"),
    ).toMatchObject({
      permission: "hotel_catalog.setup.manage",
      fields: [
        "profile.default_locale",
        "profile.short_description",
        "profile.hero_image",
        "profile.gallery_images",
        "profile.amenities",
      ],
    });
    expect(
      PROPERTY_SETUP_STEP_DEFINITIONS.find(({ stepId }) => stepId === "payments"),
    ).toMatchObject({
      permission: "booking.settings.manage",
      fields: ["payment.accepted_methods"],
    });
    expect(
      PROPERTY_SETUP_STEP_DEFINITIONS.find(({ stepId }) => stepId === "guest_experience")?.fields,
    ).toContain("policy.cancellation_bundle_confirmation");

    const fields = PROPERTY_SETUP_STEP_DEFINITIONS.flatMap(({ fields }) => fields);
    expect(new Set(fields).size).toBe(fields.length);
    for (const { baseRevisionKeys } of PROPERTY_SETUP_STEP_DEFINITIONS) {
      expect(new Set(baseRevisionKeys).size).toBe(baseRevisionKeys.length);
    }
    expect(
      Object.fromEntries(
        PROPERTY_SETUP_STEP_DEFINITIONS.map(({ stepId, baseRevisionKeys }) => [
          stepId,
          baseRevisionKeys.join("|"),
        ]),
      ),
    ).toEqual({
      present_hotel: "hotel_catalog.profile|hotel_catalog.media|hotel_catalog.amenities",
      marketplace_preferences: "marketplace.collaboration_preferences",
      booking_design: "booking.design|hotel_catalog.profile|hotel_catalog.media",
      rooms: "pms.room_types|pms.room_units|pms.room_media",
      pricing: "pms.pricing_settings|pms.rate_plans|pms.rate_rules",
      calendar: "pms.operating_calendar|pms.inventory|pms.room_units|hotel_catalog.time_zone",
      guest_experience: "booking.guest_experience",
      payments: "finance.payment_methods|pms.pricing_settings",
      review: "",
    });
    expectTypeOf<PropertySetupDraftPayload<"review">>().toEqualTypeOf<
      Readonly<Record<string, never>>
    >();
    expectTypeOf<PropertySetupBaseRevisions<"review">>().toEqualTypeOf<
      Readonly<Record<string, never>>
    >();
    expectTypeOf<PropertySetupDraftPayload<"present_hotel">>()
      .toHaveProperty("profile.default_locale")
      .toEqualTypeOf<JsonValue | undefined>();
    expectTypeOf<SavePropertySetupDraftReceipt>().not.toHaveProperty("payload");
    expectTypeOf<SavePropertySetupDraftReceipt>().not.toHaveProperty("baseRevisions");
    expectTypeOf<SavePropertySetupDraftResult>().toMatchTypeOf<
      { ok: true; receipt: SavePropertySetupDraftReceipt } | { ok: false; error: { code: string } }
    >();
  });

  it.each([
    [[], []],
    [["creator_marketplace"], ["present_hotel", "marketplace_preferences", "review"]],
    [
      ["hotel_operations"],
      [
        "present_hotel",
        "booking_design",
        "rooms",
        "payments",
        "pricing",
        "calendar",
        "guest_experience",
        "review",
      ],
    ],
    [
      ["hotel_operations", "creator_marketplace"],
      [
        "present_hotel",
        "marketplace_preferences",
        "booking_design",
        "rooms",
        "payments",
        "pricing",
        "calendar",
        "guest_experience",
        "review",
      ],
    ],
  ] as const)("returns contiguous active steps for tracks %j", (tracks, expected) => {
    expect(getActivePropertySetupStepIds(tracks)).toEqual(expected);
  });
});
