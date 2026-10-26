import { createHash } from "node:crypto";

import { parseBookingGuestPolicyPmsCurrentOwnerEvidence } from "@vayada/domain-booking";
import { isPropertySetupBaseRevisionManifest } from "@vayada/domain-hotels";
import {
  PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
  createPmsMandatoryChargePricingSourceSnapshot,
  createPmsOperatingCalendarSourceRevision,
  parsePmsMandatoryChargePricingSourceFingerprint,
  parsePmsPricingSourceSnapshot,
  parsePmsRecurringPricingBookingEvidence,
  parseRoomTypeFacts,
  type PmsCanonicalIanaTimeZone,
  type PmsOperatingCalendarCurrentReadResult,
  type PmsOperatingCalendarStaleSourceConflict,
} from "@vayada/domain-pms";
import { describe, expect, it, vi } from "vitest";

import {
  createPropertySetupBookingGuestPolicyPmsCurrentOwnerEvidenceAdapter,
  createPropertySetupPmsStateProvider,
  type PropertySetupPmsStateOptions,
} from "./platform/propertySetupPmsState.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const actorUserId = "33333333-3333-4333-8333-333333333333";

describe("property setup PMS owner state", () => {
  it("returns complete exact-key first-visit manifests from truthful empty owner facts", async () => {
    const inventory = vi.fn();
    const provider = createPropertySetupPmsStateProvider(
      options({
        owner: {
          getRoomOwnerSnapshot: vi.fn(async () => emptyRooms()),
          getInventoryOwnerSnapshot: inventory.mockResolvedValue(null),
        },
      }),
    );

    const result = await provider.getOwnerState(request());
    expect(result).toMatchObject({
      outcome: "found",
      facts: [
        {
          stepId: "rooms",
          state: "not_started",
          sourceRevision: expect.stringMatching(/^rooms-state:[0-9a-f]{64}$/),
        },
        { stepId: "pricing", state: "not_started" },
        { stepId: "calendar", state: "not_started" },
      ],
    });
    if (result.outcome !== "found") throw new Error("Expected PMS facts");
    for (const fact of result.facts) {
      expect(isPropertySetupBaseRevisionManifest(fact.stepId, fact.currentBaseRevisions)).toBe(
        true,
      );
      for (const revision of Object.values(fact.currentBaseRevisions)) {
        expect(revision).toMatch(/^[a-z-]+:(?:0|[0-9a-f]{64})$/);
      }
    }
    expect(Object.keys(result.facts[0]!.currentBaseRevisions)).toEqual([
      "pms.room_types",
      "pms.room_units",
      "pms.room_media",
    ]);
    expect(Object.keys(result.facts[1]!.currentBaseRevisions)).toEqual([
      "pms.pricing_settings",
      "pms.rate_plans",
      "pms.rate_rules",
    ]);
    expect(Object.keys(result.facts[2]!.currentBaseRevisions)).toEqual([
      "pms.operating_calendar",
      "pms.inventory",
      "pms.room_units",
      "hotel_catalog.time_zone",
    ]);
    // Today's values under the keys calendar drafts used before VAY-2198, for converting them.
    expect(result.facts[2]).toMatchObject({
      legacyBaseRevisions: {
        "pms.operating_calendar": "calendar:0",
        "pms.inventory": "inventory:0",
        "pms.room_types": result.facts[0]!.currentBaseRevisions["pms.room_types"],
        "hotel_catalog.location": `hotel_catalog.location:${propertyId}:r5`,
      },
    });
    expect(inventory).toHaveBeenCalledTimes(2);
  });

  it("pins the calendar draft to the time zone, the rooms and their units (VAY-2198)", async () => {
    const calendarManifest = async (
      overrides: Partial<PropertySetupPmsStateOptions>,
      room: Partial<{
        roomTypeId: string;
        roomFactsRevision: number;
        roomUnitsRevision: number;
      }> = {},
    ) => {
      const result = await createPropertySetupPmsStateProvider(
        options({
          owner: {
            getRoomOwnerSnapshot: vi.fn(async () => ({
              ...emptyRooms(),
              rooms: [{ ...completeRoom(), ...room }],
            })),
            getInventoryOwnerSnapshot: vi.fn(async () => null),
          },
          ...overrides,
        }),
      ).getOwnerState(request());
      if (result.outcome !== "found") throw new Error("Expected PMS facts");
      return result.facts[2]!.currentBaseRevisions;
    };
    const saved = await calendarManifest({});

    const changed = (manifest: typeof saved) =>
      Object.keys(saved).filter(
        (key) => manifest[key as keyof typeof saved] !== saved[key as keyof typeof saved],
      );

    // Room details and an address edit that keeps the time zone leave the draft current.
    expect(changed(await calendarManifest({}, { roomFactsRevision: 3 }))).toEqual([]);
    expect(
      changed(
        await calendarManifest({ catalogLocation: catalogLocation(6) }, { roomFactsRevision: 3 }),
      ),
    ).toEqual([]);
    // New units, another room or another time zone change what the calendar uses.
    expect(changed(await calendarManifest({}, { roomUnitsRevision: 3 }))).toEqual([
      "pms.room_units",
    ]);
    expect(
      changed(await calendarManifest({}, { roomTypeId: "66666666-6666-4666-8666-666666666666" })),
    ).toEqual(["pms.room_units"]);
    expect(await calendarManifest({ propertyTimeZone: timeZone("Asia/Kolkata") })).toEqual({
      ...saved,
      "hotel_catalog.time_zone": `time-zone:${sha256("Asia/Kolkata")}`,
    });
    expect(saved["hotel_catalog.time_zone"]).toBe(`time-zone:${sha256("Asia/Colombo")}`);
    expect(
      await calendarManifest({
        propertyTimeZone: {
          getPropertyProfileEvidence: vi.fn(async () => ({
            status: "timezone_missing" as const,
            source: profileSource(propertyId),
          })),
        },
      }),
    ).toMatchObject({ "hotel_catalog.time_zone": "time-zone:missing" });

    // Evidence for another property fails closed.
    await expect(
      createPropertySetupPmsStateProvider(
        options({
          propertyTimeZone: {
            getPropertyProfileEvidence: vi.fn(async () => ({
              status: "timezone_missing" as const,
              source: profileSource("77777777-7777-4777-8777-777777777777"),
            })),
          },
        }),
      ).getOwnerState(request()),
    ).resolves.toEqual({ outcome: "provider_failure" });
  });

  it("offers legacy values for old drafts only while units match the saved calendar", async () => {
    const legacyValues = async (calendar: PmsOperatingCalendarCurrentReadResult | null) => {
      const result = await createPropertySetupPmsStateProvider(
        options({
          owner: {
            getRoomOwnerSnapshot: vi.fn(async () => ({ ...emptyRooms(), rooms: [completeRoom()] })),
            getInventoryOwnerSnapshot: vi.fn(async () => null),
          },
          operatingCalendar: {
            getCurrentOperatingCalendarConfiguration: vi.fn(async () => calendar),
          },
        }),
      ).getOwnerState(request());
      if (result.outcome !== "found") throw new Error("Expected PMS facts");
      return result.facts[2]!.legacyBaseRevisions;
    };
    const roomTypeId = completeRoom().roomTypeId;

    expect(await legacyValues(null)).toMatchObject({ "pms.operating_calendar": "calendar:0" });
    expect(await legacyValues(savedCalendar())).toMatchObject({
      "pms.operating_calendar": "calendar:1",
    });
    // Time zone and room-set changes already change the legacy values; units need the calendar.
    expect(
      await legacyValues(
        savedCalendar([{ code: "property_profile_revision_conflict", currentRevision: 5 }]),
      ),
    ).toMatchObject({ "pms.operating_calendar": "calendar:1" });
    expect(
      await legacyValues(
        savedCalendar([{ code: "room_units_revision_conflict", roomTypeId, currentRevision: 3 }]),
      ),
    ).toBeUndefined();
    expect(
      await legacyValues(savedCalendar([{ code: "room_capacity_unavailable", roomTypeId }])),
    ).toBeUndefined();
  });

  it("fails closed on owner revision races and malformed mandatory-charge facts", async () => {
    const getRoomOwnerSnapshot = vi
      .fn()
      .mockResolvedValueOnce(emptyRooms())
      .mockResolvedValueOnce({ ...emptyRooms(), rooms: [completeRoom()] });
    const raced = createPropertySetupPmsStateProvider(
      options({
        owner: {
          getRoomOwnerSnapshot,
          getInventoryOwnerSnapshot: vi.fn(async () => null),
        },
      }),
    );
    await expect(raced.getOwnerState(request())).resolves.toEqual({
      outcome: "provider_failure",
    });

    const malformed = createPropertySetupPmsStateProvider(
      options({
        mandatoryCharges: {
          getMandatoryChargeConfirmation: vi.fn(async () => ({ outcome: "missing" }) as never),
        },
      }),
    );
    await expect(malformed.getOwnerState(request())).resolves.toEqual({
      outcome: "provider_failure",
    });
  });

  it("reports independent partial pricing state without requiring recurring pricing", async () => {
    const provider = createPropertySetupPmsStateProvider(
      options({
        owner: {
          getRoomOwnerSnapshot: vi.fn(async (_input) => emptyRooms()),
          getInventoryOwnerSnapshot: vi.fn(async (_input) => null),
        },
        pricing: { getPricingSourceSnapshot: vi.fn(async () => pricingSnapshot()) },
      }),
    );

    await expect(provider.getOwnerState(request())).resolves.toMatchObject({
      outcome: "found",
      facts: [
        { stepId: "rooms", state: "not_started" },
        { stepId: "pricing", state: "saved" },
        { stepId: "calendar", state: "not_started" },
      ],
    });
  });

  it("fails closed on impossible recurring evidence without base pricing", async () => {
    const provider = createPropertySetupPmsStateProvider(
      options({
        recurringPricing: {
          getRecurringPricingBookingEvidence: vi.fn(async () => recurringPricingSnapshot()),
        },
      }),
    );

    await expect(provider.getOwnerState(request())).resolves.toEqual({
      outcome: "provider_failure",
    });
  });

  it("marks rooms and pricing complete only from matching current owner evidence", async () => {
    const pricing = pricingSnapshot();
    const recurring = recurringPricingSnapshot();
    const pricingSource = createPmsMandatoryChargePricingSourceSnapshot({
      rooms: [
        {
          roomTypeId: completeRoom().roomTypeId,
          roomFactsRevision: completeRoom().roomFactsRevision,
          occupancy: completeRoom().facts.occupancy,
        },
      ],
      pricing,
      recurringPricing: recurring,
    });
    const fingerprint = parsePmsMandatoryChargePricingSourceFingerprint(
      createHash("sha256").update(pricingSource.serializedPayload).digest("hex"),
    )!;
    const provider = createPropertySetupPmsStateProvider(
      options({
        owner: {
          getRoomOwnerSnapshot: vi.fn(async (_input) => ({
            ...emptyRooms(),
            rooms: [completeRoom()],
          })),
          getInventoryOwnerSnapshot: vi.fn(async (_input) => null),
        },
        pricing: { getPricingSourceSnapshot: vi.fn(async () => pricing) },
        recurringPricing: {
          getRecurringPricingBookingEvidence: vi.fn(async () => recurring),
        },
        mandatoryCharges: {
          getMandatoryChargeConfirmation: vi.fn(async () => ({
            outcome: "available" as const,
            organizationId,
            propertyId,
            evidence: {
              organizationId,
              propertyId,
              pricingSourceFingerprint: fingerprint,
              confirmationRevision: 3,
              confirmedAt: "2026-08-05T12:00:00.000Z",
            },
          })),
        },
      }),
    );

    await expect(provider.getOwnerState(request())).resolves.toMatchObject({
      outcome: "found",
      facts: [
        { stepId: "rooms", state: "complete" },
        { stepId: "pricing", state: "complete" },
        { stepId: "calendar", state: "not_started" },
      ],
    });
  });

  it("completes pricing from published offers for every operating room", async () => {
    // A publication whose only offer is non-refundable has no flexible plan.
    const pricing = { ...pricingSnapshot(), flexibleRatePlans: [] };
    const recurring = recurringPricingSnapshot();
    const room = completeRoom();
    const fingerprint = parsePmsMandatoryChargePricingSourceFingerprint(
      createHash("sha256")
        .update(
          createPmsMandatoryChargePricingSourceSnapshot({
            rooms: [
              {
                roomTypeId: room.roomTypeId,
                roomFactsRevision: room.roomFactsRevision,
                occupancy: room.facts.occupancy,
              },
            ],
            pricing,
            recurringPricing: recurring,
          }).serializedPayload,
        )
        .digest("hex"),
    )!;
    const state = async (publishedRoomIds: string[]) => {
      const provider = createPropertySetupPmsStateProvider(
        options({
          owner: {
            getRoomOwnerSnapshot: vi.fn(async (_input) => ({ ...emptyRooms(), rooms: [room] })),
            getInventoryOwnerSnapshot: vi.fn(async (_input) => null),
          },
          pricing: { getPricingSourceSnapshot: vi.fn(async () => pricing) },
          publishedPricing: { listPublishedOfferRoomTypeIds: vi.fn(async () => publishedRoomIds) },
          recurringPricing: { getRecurringPricingBookingEvidence: vi.fn(async () => recurring) },
          mandatoryCharges: {
            getMandatoryChargeConfirmation: vi.fn(async () => ({
              outcome: "available" as const,
              organizationId,
              propertyId,
              evidence: {
                organizationId,
                propertyId,
                pricingSourceFingerprint: fingerprint,
                confirmationRevision: 1,
                confirmedAt: "2026-08-05T12:00:00.000Z",
              },
            })),
          },
        }),
      );
      const result = await provider.getOwnerState(request());
      return result.outcome === "found"
        ? result.facts.find(({ stepId }) => stepId === "pricing")
        : undefined;
    };

    expect(await state([room.roomTypeId])).toMatchObject({ state: "complete" });
    // A publication that does not cover the room leaves the step saved.
    const uncovered = await state([]);
    expect(uncovered).toMatchObject({ state: "saved" });
    expect(uncovered?.sourceRevision).not.toBe((await state([room.roomTypeId]))?.sourceRevision);
  });

  it("bridges exact current PMS guest-policy keys and rejects revision races", async () => {
    const owner = {
      getRoomOwnerSnapshot: vi.fn(async () => emptyRooms()),
      getInventoryOwnerSnapshot: vi.fn(async () => null),
    };
    const bridge = createPropertySetupBookingGuestPolicyPmsCurrentOwnerEvidenceAdapter({
      owner,
      pricing: { getPricingSourceSnapshot: vi.fn(async () => null) },
    });
    const result = await bridge.getCurrentGuestPolicyBaseRevisions({
      organizationId,
      propertyId,
    });
    expect(
      parseBookingGuestPolicyPmsCurrentOwnerEvidence(result, { organizationId, propertyId }),
    ).toEqual(result);
    expect(result).toMatchObject({
      outcome: "available",
      evidence: {
        revisions: {
          "pms.pricing_settings": "pricing:0",
          "pms.rate_plans": expect.stringMatching(/^rate-plans:[0-9a-f]{64}$/),
          "pms.room_types": expect.stringMatching(/^room-types:[0-9a-f]{64}$/),
        },
      },
    });

    const racedOwner = {
      ...owner,
      getRoomOwnerSnapshot: vi
        .fn()
        .mockResolvedValueOnce(emptyRooms())
        .mockResolvedValueOnce({ ...emptyRooms(), rooms: [completeRoom()] }),
    };
    await expect(
      createPropertySetupBookingGuestPolicyPmsCurrentOwnerEvidenceAdapter({
        owner: racedOwner,
        pricing: { getPricingSourceSnapshot: vi.fn(async () => null) },
      }).getCurrentGuestPolicyBaseRevisions({ organizationId, propertyId }),
    ).resolves.toEqual({ outcome: "unavailable", errorSource: "provider" });
  });
});

function options(
  overrides: Partial<PropertySetupPmsStateOptions> = {},
): PropertySetupPmsStateOptions {
  return {
    owner: {
      getRoomOwnerSnapshot: vi.fn(async (_input) => emptyRooms()),
      getInventoryOwnerSnapshot: vi.fn(async (_input) => null),
    },
    pricing: { getPricingSourceSnapshot: vi.fn(async () => null) },
    publishedPricing: { listPublishedOfferRoomTypeIds: vi.fn(async () => null) },
    recurringPricing: { getRecurringPricingBookingEvidence: vi.fn(async () => null) },
    mandatoryCharges: {
      getMandatoryChargeConfirmation: vi.fn(async () => ({
        outcome: "missing" as const,
        organizationId,
        propertyId,
      })),
    },
    operatingCalendar: { getCurrentOperatingCalendarConfiguration: vi.fn(async () => null) },
    calendarRegistry: {
      ownerDomain: "hotel_catalog",
      registryVersion: "test.v1",
      isCanonicalIanaTimeZone: vi.fn(() => true),
    },
    propertyTimeZone: timeZone("Asia/Colombo"),
    catalogLocation: catalogLocation(5),
    ...overrides,
  };
}

function catalogLocation(revision: number): PropertySetupPmsStateOptions["catalogLocation"] {
  return {
    ownerKey: "hotel_catalog.location",
    getCurrentLocationOwnerEvidence: vi.fn(async () => ({
      outcome: "available" as const,
      evidence: {
        organizationId,
        propertyId,
        ownerKey: "hotel_catalog.location" as const,
        sourceIdentity: `hotel_catalog.location:${propertyId}` as const,
        revision,
        baseRevision: `hotel_catalog.location:${propertyId}:r${revision}` as const,
      },
    })),
  };
}

function timeZone(name: string): PropertySetupPmsStateOptions["propertyTimeZone"] {
  return {
    getPropertyProfileEvidence: vi.fn(async () => ({
      status: "available" as const,
      evidence: { source: profileSource(propertyId), timeZone: name as PmsCanonicalIanaTimeZone },
    })),
  };
}

function profileSource(entityId: string) {
  return {
    ownerDomain: "hotel_catalog" as const,
    entityType: "property_profile" as const,
    entityId,
    revision: "profile:4",
  };
}

function savedCalendar(
  sourceConflicts: readonly PmsOperatingCalendarStaleSourceConflict[] = [],
): PmsOperatingCalendarCurrentReadResult {
  const configuration = {
    contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
    propertyId,
    calendarRevision: 1,
    source: createPmsOperatingCalendarSourceRevision(propertyId, 1),
    sourceInputs: {
      propertyProfile: profileSource(propertyId),
      propertyTimeZone: "Asia/Colombo" as PmsCanonicalIanaTimeZone,
      roomBindings: [
        {
          roomTypeId: completeRoom().roomTypeId,
          sourceRoomFactsRevision: completeRoom().roomFactsRevision,
          sourceRoomUnitsRevision: completeRoom().roomUnitsRevision,
          physicalCapacityCount: completeRoom().activeUnitCount,
          startingSellableLimitCount: 1,
        },
      ],
    },
    schedule: { mode: "year_round" as const, periods: [] as const },
    defaultMinimumStayNights: 2,
    createdAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:00:00.000Z",
  };
  return sourceConflicts.length === 0
    ? { configuration, sourceStatus: "current", sourceConflicts: [] }
    : { configuration, sourceStatus: "stale", sourceConflicts };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function request() {
  return {
    organizationId,
    propertyId,
    actorUserId,
    selectedTracks: ["hotel_operations"] as const,
    expectedTrackRevision: 3,
    stepIds: ["rooms", "pricing", "calendar"] as const,
  };
}

function emptyRooms() {
  return {
    organizationId,
    propertyId,
    rooms: [],
  } as const;
}

function completeRoom() {
  return {
    roomTypeId: "44444444-4444-4444-8444-444444444444",
    facts: parseRoomTypeFacts({
      name: "Double Room",
      description: "A comfortable double room.",
      category: null,
      occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 1 },
      beds: [{ type: "double", quantity: 1 }],
      bedrooms: 1,
      bathrooms: 1,
      bathroomType: "private",
      size: null,
    })!,
    roomFactsRevision: 2,
    roomUnitsRevision: 2,
    activeUnitCount: 1,
    roomMediaRevision: 2,
    mediaAssignmentCount: 1,
    roomAmenitiesRevision: 2,
    amenitiesReviewed: true,
  } as const;
}

function pricingSnapshot() {
  return parsePmsPricingSourceSnapshot({
    contractVersion: "pms-pricing.v1",
    propertyId,
    pricingCurrency: {
      contractVersion: "pms-pricing.v1",
      propertyId,
      currency: "EUR",
      pricingCurrencyRevision: 2,
      createdAt: "2026-08-05T12:00:00.000Z",
      updatedAt: "2026-08-05T12:00:00.000Z",
    },
    flexibleRatePlans: [
      {
        contractVersion: "pms-pricing.v1",
        propertyId,
        roomTypeId: completeRoom().roomTypeId,
        flexibleRatePlanId: "55555555-5555-4555-8555-555555555555",
        flexibleRatePlanRevision: 3,
        sourceRoomFactsRevision: completeRoom().roomFactsRevision,
        baseAmount: { amountDecimal: "160.00", currency: "EUR" },
        cancellationTerms: {
          type: "free_until_days_before_arrival",
          freeCancellationDeadlineDays: 7,
          afterDeadlinePenalty: "full_booking_amount",
          noShowPenalty: "full_booking_amount",
        },
        createdAt: "2026-08-05T12:00:00.000Z",
        updatedAt: "2026-08-05T12:00:00.000Z",
      },
    ],
    capturedAt: "2026-08-05T12:00:00.000Z",
  })!;
}

function recurringPricingSnapshot() {
  return parsePmsRecurringPricingBookingEvidence({
    contractVersion: "pms-recurring-pricing.v1",
    propertyId,
    pricingCurrencyRevision: 2,
    optionalPricingAggregateRevision: 0,
    currency: "EUR",
    sources: [],
    capturedAt: "2026-08-05T12:00:00.000Z",
  })!;
}
