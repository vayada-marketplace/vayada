import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertEnabled: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  uploadImages: vi.fn(),
  resolvePropertyId: vi.fn(),
}));

vi.mock("../api/pmsOperationsClient", () => ({
  assertPmsOperationsReadModelEnabled: mocks.assertEnabled,
  pmsOperationsClient: {
    get: mocks.get,
    post: mocks.post,
    put: mocks.put,
    patch: mocks.patch,
    delete: mocks.delete,
  },
  pmsOperationsRequestOptions: { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
}));

vi.mock("../upload", () => ({
  imageReferenceUrl: (image: string | { url?: string | null }) =>
    typeof image === "string" ? image : (image.url ?? ""),
  pmsRoomMediaResource: (propertyId: string, roomTypeId?: string) => ({
    product: "hotel_catalog",
    resourceType: "property",
    resourceId: propertyId,
    propertyId,
    ...(roomTypeId ? { targetResourceId: roomTypeId } : {}),
  }),
  uploadService: { uploadImages: mocks.uploadImages },
}));

vi.mock("../api/pmsPropertyClient", () => ({
  resolveSelectedPmsPropertyId: mocks.resolvePropertyId,
}));

vi.mock("../api/unsupported", () => ({
  unsupportedPmsNextStackFeature: vi.fn((feature: string) =>
    Promise.reject(new Error(`${feature} is not available on PMS next-stack yet.`)),
  ),
}));

import { individualRoomsService, linkedInventoryGroupsService, roomsService } from ".";
import { ApiErrorResponse } from "../api/client";

function pmsRoomTypeItem(overrides: Record<string, unknown> = {}) {
  return {
    roomTypeId: "room-type-1",
    version: "room-type-facts-v3",
    name: "Alpine Suite",
    description: "Suite",
    category: "suite",
    occupancyLimits: { total: 2 },
    attributes: {},
    amenities: [],
    media: [],
    roomMediaRevision: 3,
    baseRate: { amountDecimal: "180.00", currency: "EUR" },
    active: true,
    sortOrder: 1,
    ratePlans: [],
    rateRulesSummary: {
      minStayNights: null,
      maxStayNights: null,
      closedToArrival: false,
      closedToDeparture: false,
      activeRuleCount: 0,
    },
    roomCount: 2,
    ...overrides,
  };
}

const canonicalAt = "2026-09-04T00:00:00.000Z";

function canonicalRoomFacts(propertyId: string, roomTypeId: string, roomFactsRevision = 1) {
  return {
    contractVersion: "pms-room-facts.v1",
    propertyId,
    roomTypeId,
    roomFactsRevision,
    lifecycle: "active",
    facts: {
      name: "Castrop Suite",
      description: "Suite",
      category: "suite",
      occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
      beds: [{ type: "queen", quantity: 1 }],
      bedrooms: 1,
      bathrooms: 1,
      bathroomType: "private",
      size: null,
    },
    createdAt: canonicalAt,
    updatedAt: canonicalAt,
  };
}

describe("roomsService lifecycle commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePropertyId.mockResolvedValue("pms-property-1");
  });

  it("duplicates with the source version and reuses the command after an ambiguous failure", async () => {
    mocks.get.mockResolvedValue({
      propertyId: "pms-property-1",
      item: pmsRoomTypeItem(),
    });
    mocks.post.mockRejectedValueOnce(new Error("network interrupted")).mockResolvedValueOnce({
      propertyId: "pms-property-1",
      item: pmsRoomTypeItem({
        roomTypeId: "room-type-copy",
        version: "room-type-facts-v1",
        name: "Alpine Suite Copy",
        roomCount: 0,
      }),
    });

    await expect(roomsService.duplicate("room-type-1")).rejects.toThrow("network interrupted");
    const duplicated = await roomsService.duplicate("room-type-1");

    expect(duplicated).toMatchObject({
      id: "room-type-copy",
      version: "room-type-facts-v1",
      name: "Alpine Suite Copy",
      totalRooms: 0,
    });
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[0]![1]).toMatchObject({
      expectedVersion: "room-type-facts-v3",
      commandId: expect.stringMatching(/^pms-room-type-duplicate-/),
    });
    expect(mocks.post.mock.calls[1]![1]).toEqual(mocks.post.mock.calls[0]![1]);
  });

  it("preflights retirement and returns actionable blockers without dispatching delete", async () => {
    mocks.get.mockResolvedValue({
      contractVersion: "pms-room-type-lifecycle.v1",
      propertyId: "pms-property-1",
      roomTypeId: "room-type-1",
      version: "room-type-facts-v3",
      canRetire: false,
      blockers: [
        {
          category: "physical_units",
          code: "active_physical_units",
          affectedCount: 2,
          action: "Retire every active physical room unit.",
        },
      ],
    });

    await expect(roomsService.delete("room-type-1")).rejects.toThrow(
      "2 affected: Retire every active physical room unit.",
    );
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("retires with the inspected version and a durable retry key", async () => {
    mocks.get.mockResolvedValue({
      contractVersion: "pms-room-type-lifecycle.v1",
      propertyId: "pms-property-1",
      roomTypeId: "room-type-1",
      version: "room-type-facts-v3",
      canRetire: true,
      blockers: [],
    });
    mocks.delete.mockResolvedValue({});

    await roomsService.delete("room-type-1");

    expect(mocks.delete).toHaveBeenCalledWith(
      "/api/pms/properties/pms-property-1/room-types/room-type-1",
      expect.objectContaining({
        body: expect.stringContaining('"expectedVersion":"room-type-facts-v3"'),
      }),
    );
    const payload = JSON.parse(mocks.delete.mock.calls[0]![1].body);
    expect(payload.commandId).toMatch(/^pms-room-type-retire-/);
    expect(payload.idempotencyKey).toBe(payload.commandId);
  });
});

describe("roomsService.update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePropertyId.mockResolvedValue("pms-property-1");
    mocks.patch.mockResolvedValue({
      contractVersion: "pms-operations.v1",
      propertyId: "pms-property-1",
      item: pmsRoomTypeItem({
        description: "Suite with mountain view.",
        occupancyLimits: { adults: 2, total: 2 },
        attributes: {
          locationAddress: "Seestrasse 12, Innsbruck",
          latitude: 47.2692,
          longitude: 11.4041,
        },
      }),
      commandMeta: {
        contractVersion: "pms-operations.v1",
        commandId: "cmd",
        idempotencyKey: "cmd",
        acceptedAt: "2026-08-14T17:45:00.000Z",
        sideEffects: ["audit_event"],
      },
    });
  });

  it("keeps non-pricing room changes on the PMS operations command", async () => {
    const roomType = await roomsService.update("room-type-1", {
      name: "Ignored by location update",
      cancellationPolicy: "Free until 3 days before",
      seasons: [
        { name: "Peak", tier: "high", from: "07-01", to: "08-31", rate: "240", minStay: 1 },
      ],
      locationAddress: "Seestrasse 12, Innsbruck",
      latitude: 47.2692,
      longitude: 11.4041,
    });

    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/pms/properties/pms-property-1/room-types/room-type-1",
      expect.objectContaining({
        locationAddress: "Seestrasse 12, Innsbruck",
        latitude: 47.2692,
        longitude: 11.4041,
        commandId: expect.stringMatching(/^pms-room-type-update-/),
        idempotencyKey: expect.stringMatching(/^pms-room-type-update-/),
      }),
      { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
    );
    expect(mocks.patch.mock.calls[0]![1]).not.toHaveProperty("name");
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.patch.mock.calls[0]![1]).not.toHaveProperty("cancellationPolicy");
    expect(roomType).toMatchObject({
      id: "room-type-1",
      locationAddress: "Seestrasse 12, Innsbruck",
      latitude: 47.2692,
      longitude: 11.4041,
    });
  });

  it("ignores published pricing-v2 offers when showing the legacy room rates", async () => {
    mocks.get.mockImplementation(async (endpoint: string) =>
      endpoint.endsWith("/pricing-source")
        ? {
            pricingCurrency: { currency: "EUR", pricingCurrencyRevision: 4 },
            flexibleRatePlans: [],
          }
        : {
            propertyId: "pms-property-1",
            item: pmsRoomTypeItem({
              baseRate: { amountDecimal: "180.00", currency: "EUR" },
              // A linked Non-refundable offer has no base of its own (0 in the payload).
              ratePlans: [
                {
                  ratePlanId: "nr-offer",
                  pricingContractVersion: "pricing.v2",
                  code: "nr-offer",
                  name: "Non-refundable",
                  rateType: "non_refundable",
                  mealPlan: "room_only",
                  baseRate: { amountDecimal: "0", currency: "EUR" },
                  cancellationPolicySnapshot: { kind: "non_refundable" },
                  active: true,
                },
              ],
            }),
          },
    );

    const roomType = await roomsService.get("room-type-1");
    expect(roomType).toMatchObject({ nonRefundableEnabled: false, nonRefundableDiscount: 5 });
  });

  it("shows canonical room facts in the PMS room form", async () => {
    mocks.get.mockResolvedValue({
      propertyId: "pms-property-1",
      item: pmsRoomTypeItem({
        category: "deluxe",
        attributes: {
          beds: [
            { type: "king", quantity: 1 },
            { type: "sofa_bed", quantity: 2 },
          ],
          size: { value: 32, unit: "sqm" },
        },
        amenities: ["wifi", "in_room_safe", "balcony"],
      }),
    });

    await expect(roomsService.get("room-type-1")).resolves.toMatchObject({
      category: "Deluxe",
      bedType: "1 King Bed, 2 Sofa Bed",
      size: 32,
      amenities: ["Free WiFi", "Safe", "balcony"],
    });
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing gate when PMS operations writes are disabled", async () => {
    mocks.assertEnabled.mockImplementationOnce(() => {
      throw new Error("PMS operations disabled");
    });

    await expect(roomsService.update("room-type-1", { latitude: 47.2692 })).rejects.toThrow(
      "PMS operations disabled",
    );
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("persists changed room media through the revisioned assignment endpoint", async () => {
    const currentItem = pmsRoomTypeItem({
      media: [
        {
          mediaObjectId: "11111111-1111-4111-8111-111111111111",
          url: "https://cdn.example.com/old.webp",
        },
      ],
    });
    mocks.patch.mockResolvedValueOnce({
      contractVersion: "pms-operations.v1",
      propertyId: "pms-property-1",
      item: currentItem,
    });
    mocks.put.mockResolvedValue({
      propertyId: "pms-property-1",
      roomTypeId: "room-type-1",
      roomMediaRevision: 4,
    });
    mocks.get.mockResolvedValue({
      propertyId: "pms-property-1",
      item: {
        ...currentItem,
        media: [
          {
            mediaObjectId: "22222222-2222-4222-8222-222222222222",
            url: "https://cdn.example.com/new.webp",
          },
        ],
        roomMediaRevision: 4,
      },
    });

    const updated = await roomsService.update("room-type-1", {
      images: [
        {
          url: "https://cdn.example.com/new.webp",
          platformMediaObjectId: "22222222-2222-4222-8222-222222222222",
        },
      ],
    });

    expect(mocks.put).toHaveBeenCalledWith(
      "/api/pms/properties/pms-property-1/room-types/room-type-1/media",
      {
        expectedRoomMediaRevision: 3,
        assignments: [
          {
            mediaObjectId: "22222222-2222-4222-8222-222222222222",
            altText: null,
            sortOrder: 0,
          },
        ],
      },
      expect.objectContaining({
        headers: expect.objectContaining({ "Idempotency-Key": expect.any(String) }),
      }),
    );
    expect(updated.images[0]).toMatchObject({
      platformMediaObjectId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("persists reordering and removal for URL-only legacy room photos", async () => {
    const currentItem = pmsRoomTypeItem({
      media: [
        { url: "https://legacy.example.com/first.webp" },
        { url: "https://legacy.example.com/second.webp" },
      ],
    });
    mocks.patch.mockResolvedValueOnce({
      contractVersion: "pms-operations.v1",
      propertyId: "pms-property-1",
      item: currentItem,
    });
    mocks.put.mockResolvedValue({ roomMediaRevision: 4 });
    mocks.get.mockResolvedValue({
      propertyId: "pms-property-1",
      item: {
        ...currentItem,
        media: [{ url: "https://legacy.example.com/second.webp" }],
        roomMediaRevision: 4,
      },
    });

    await roomsService.update("room-type-1", {
      images: [{ url: "https://legacy.example.com/second.webp" }],
    });

    expect(mocks.put).toHaveBeenCalledWith(
      "/api/pms/properties/pms-property-1/room-types/room-type-1/media",
      {
        expectedRoomMediaRevision: 3,
        assignments: [],
        legacyMediaSnapshot: [
          {
            mediaObjectId: null,
            url: "https://legacy.example.com/second.webp",
            altText: null,
            sortOrder: 0,
          },
        ],
      },
      expect.any(Object),
    );
  });

  it("rejects unfinished blob previews before replacing room media", async () => {
    mocks.patch.mockResolvedValueOnce({
      contractVersion: "pms-operations.v1",
      propertyId: "pms-property-1",
      item: pmsRoomTypeItem(),
    });

    await expect(
      roomsService.update("room-type-1", {
        images: [{ url: "blob:room-preview" }],
      }),
    ).rejects.toThrow("Every saved room photo must finish uploading before the room can be saved.");
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("preserves legacy photos while adding validated Platform Media", async () => {
    const currentItem = pmsRoomTypeItem({
      media: [{ url: "https://legacy.example.com/first.webp" }],
    });
    mocks.patch.mockResolvedValueOnce({
      contractVersion: "pms-operations.v1",
      propertyId: "pms-property-1",
      item: currentItem,
    });
    mocks.put.mockResolvedValue({ roomMediaRevision: 4 });
    mocks.get.mockResolvedValue({
      propertyId: "pms-property-1",
      item: {
        ...currentItem,
        media: [
          { url: "https://legacy.example.com/first.webp" },
          {
            mediaObjectId: "22222222-2222-4222-8222-222222222222",
            url: "https://cdn.example.com/new.webp",
          },
        ],
        roomMediaRevision: 4,
      },
    });

    await roomsService.update("room-type-1", {
      images: [
        { url: "https://legacy.example.com/first.webp" },
        {
          url: "https://cdn.example.com/new.webp",
          platformMediaObjectId: "22222222-2222-4222-8222-222222222222",
        },
      ],
    });

    expect(mocks.put.mock.calls[0]?.[1]).toEqual({
      expectedRoomMediaRevision: 3,
      assignments: [
        {
          mediaObjectId: "22222222-2222-4222-8222-222222222222",
          altText: null,
          sortOrder: 0,
        },
      ],
      legacyMediaSnapshot: [
        {
          mediaObjectId: null,
          url: "https://legacy.example.com/first.webp",
          altText: null,
          sortOrder: 0,
        },
        {
          mediaObjectId: "22222222-2222-4222-8222-222222222222",
          url: "https://cdn.example.com/new.webp",
          altText: null,
          sortOrder: 1,
        },
      ],
    });
  });
});

describe("roomsService.getPropertyPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePropertyId.mockResolvedValue("pms-property-1");
    mocks.get.mockResolvedValue({
      contractVersion: "pms-operations.v1",
      propertyId: "pms-property-1",
      propertyPlan: {
        propertyId: "pms-property-1",
        plan: "commission",
        limits: {
          maxRoomPhotosPerType: 10,
          maxAddons: 3,
          guestContactAccess: "after_acceptance",
        },
      },
    });
  });

  it("reads centralized plan limits for the selected property", async () => {
    await expect(roomsService.getPropertyPlan()).resolves.toMatchObject({
      plan: "commission",
      limits: { maxRoomPhotosPerType: 10 },
    });
    expect(mocks.get).toHaveBeenCalledWith("/api/pms/properties/pms-property-1/plan-limits", {
      headers: { "X-Vayada-Omit-Hotel-Context": "true" },
    });
  });
});

describe("roomsService.create", () => {
  const propertyId = "11111111-1111-4111-8111-111111111111";
  const roomTypeId = "22222222-2222-4222-8222-222222222222";
  const roomFactsCreated = (_path: string, body: { draftRoomId: string }) => ({
    contractVersion: "pms-room-facts.v1",
    outcome: "created",
    roomType: canonicalRoomFacts(propertyId, roomTypeId),
    draftRoomBinding: { propertyId, draftRoomId: body.draftRoomId, roomTypeId },
    acceptedAt: canonicalAt,
  });

  const amenitiesConfirmed = (amenities: string[]) => ({
    contractVersion: "pms-room-amenities.v1",
    outcome: "confirmed",
    roomAmenities: {
      contractVersion: "pms-room-amenities.v1",
      propertyId,
      roomTypeId,
      roomAmenitiesRevision: 2,
      reviewed: true,
      amenities,
      reviewedAt: canonicalAt,
    },
    acceptedAt: canonicalAt,
  });
  // Every create confirms amenities; other PUTs go to the test's own handler.
  type PutHandler = Parameters<typeof mocks.put.mockImplementation>[0];
  const putWithAmenities =
    (handler: PutHandler): PutHandler =>
    async (endpoint, body) =>
      endpoint.endsWith("/amenities")
        ? amenitiesConfirmed(body.amenities)
        : handler(endpoint, body);

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolvePropertyId.mockResolvedValue(propertyId);
    mocks.post.mockImplementation(async (path, body) => roomFactsCreated(path, body));
    mocks.put.mockImplementation(putWithAmenities(() => undefined));
  });

  it("creates the room type through the room-facts command without legacy prices", async () => {
    mocks.patch.mockResolvedValue({ propertyId, item: pmsRoomTypeItem({ roomTypeId }) });
    mocks.get.mockResolvedValue({ propertyId, item: pmsRoomTypeItem({ roomTypeId }) });

    const created = await roomsService.create({
      name: " Garden Suite ",
      description: "Quiet garden suite",
      category: "Deluxe",
      maxOccupancy: 3,
      maxAdults: 2,
      maxChildren: 1,
      bedType: "1 King Bed, 1 Sofa Bed",
      bedrooms: 1,
      bathrooms: 1,
      bathroomType: "private",
      size: 32,
      baseRate: 120,
      seasons: [
        { name: "Default", tier: "mid", from: "01-01", to: "12-31", rate: "120", minStay: 1 },
      ],
      locationAddress: "Seestrasse 12, Innsbruck",
      latitude: null,
      longitude: null,
      amenities: ["Free WiFi", "Private Bathroom", "Hairdryer"],
    });

    const [path, body, options] = mocks.post.mock.calls[0]!;
    expect(path).toBe(`/api/pms/setup/properties/${propertyId}/room-types`);
    expect(body).toEqual({
      draftRoomId: expect.stringMatching(/^pms-room-type-create-/),
      expectedRevision: 0,
      facts: {
        name: "Garden Suite",
        description: "Quiet garden suite",
        category: "deluxe",
        occupancy: { maxGuests: 3, maxAdults: 2, maxChildren: 1 },
        beds: [
          { type: "king", quantity: 1 },
          { type: "sofa_bed", quantity: 1 },
        ],
        bedrooms: 1,
        bathrooms: 1,
        bathroomType: "private",
        size: { value: 32, unit: "sqm" },
      },
    });
    expect(options.headers["Idempotency-Key"]).toBe(body.draftRoomId);
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/pms/properties/${propertyId}/room-types/${roomTypeId}`,
      expect.objectContaining({ locationAddress: "Seestrasse 12, Innsbruck" }),
      expect.any(Object),
    );
    expect(mocks.put).toHaveBeenCalledWith(
      `/api/pms/properties/${propertyId}/room-types/${roomTypeId}/amenities`,
      { expectedRoomAmenitiesRevision: 1, amenities: ["hairdryer", "wifi"] },
      expect.objectContaining({
        headers: expect.objectContaining({ "Idempotency-Key": `${body.draftRoomId}:amenities` }),
      }),
    );
    const endpoints = [mocks.get, mocks.post, mocks.put, mocks.patch].flatMap((mock) =>
      mock.mock.calls.map(([endpoint]) => String(endpoint)),
    );
    expect(endpoints.filter((endpoint) => /pricing|rate-plan/.test(endpoint))).toEqual([]);
    expect(created).toMatchObject({ id: roomTypeId });
  });

  it("checks room amenities and occupancy before writing anything", async () => {
    await expect(
      roomsService.create({
        name: "Garden Suite",
        bathroomType: "private",
        maxOccupancy: 2,
        bedType: "1 King Bed",
        amenities: ["Free WiFi", "Parking", "Concierge"],
      }),
    ).rejects.toThrow("Parking, Concierge can't be saved as room amenities.");
    await expect(
      roomsService.create({
        name: "Garden Suite",
        bathroomType: "private",
        maxOccupancy: 2,
        maxAdults: 3,
        bedType: "1 King Bed",
      }),
    ).rejects.toThrow("Max adults and max children cannot exceed the maximum occupancy.");
    await expect(
      roomsService.create({
        name: "Garden Suite",
        bathroomType: "private",
        maxOccupancy: 4,
        maxAdults: 2,
        maxChildren: 1,
        bedType: "1 King Bed",
      }),
    ).rejects.toThrow(
      "Max adults plus max children must add up to at least the maximum occupancy.",
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("treats a blank child limit as any and always confirms amenities", async () => {
    mocks.get.mockResolvedValue({ propertyId, item: pmsRoomTypeItem({ roomTypeId }) });

    await roomsService.create({
      name: "Family Room",
      bathroomType: "private",
      maxOccupancy: 4,
      maxAdults: 2,
      maxChildren: null,
      bedType: "2 Queen Bed",
    });

    expect(mocks.post.mock.calls[0]![1].facts.occupancy).toEqual({
      maxGuests: 4,
      maxAdults: 2,
      maxChildren: 4,
    });
    expect(mocks.put).toHaveBeenCalledWith(
      `/api/pms/properties/${propertyId}/room-types/${roomTypeId}/amenities`,
      { expectedRoomAmenitiesRevision: 1, amenities: [] },
      expect.any(Object),
    );
  });

  it("explains a duplicate room type name and retries with a fresh command", async () => {
    mocks.post.mockRejectedValueOnce(
      new ApiErrorResponse(409, { code: "room_type_name_conflict" }),
    );
    mocks.get.mockResolvedValue({ propertyId, item: pmsRoomTypeItem({ roomTypeId }) });
    const data = {
      name: "Garden Suite",
      bathroomType: "private" as const,
      maxOccupancy: 2,
      bedType: "1 King Bed",
    };

    await expect(roomsService.create(data)).rejects.toThrow(
      "A room type with this name already exists.",
    );
    await expect(roomsService.create(data)).resolves.toMatchObject({ id: roomTypeId });

    const [first, second] = mocks.post.mock.calls.map(([, body]) => body.draftRoomId);
    expect(second).not.toBe(first);
  });

  it("uploads staged files only after receiving the canonical room UUID", async () => {
    const item = pmsRoomTypeItem({
      roomTypeId,
      roomMediaRevision: 1,
    });
    mocks.uploadImages.mockResolvedValue({
      images: [
        {
          platformMediaObjectId: "22222222-2222-4222-8222-222222222222",
          url: "https://cdn.example.com/new.webp",
        },
      ],
      total: 1,
    });
    mocks.put.mockImplementation(putWithAmenities(() => ({ roomMediaRevision: 2 })));
    mocks.get.mockResolvedValueOnce({ propertyId, item }).mockResolvedValueOnce({
      propertyId,
      item: {
        ...item,
        roomMediaRevision: 2,
        media: [
          {
            mediaObjectId: "22222222-2222-4222-8222-222222222222",
            url: "https://cdn.example.com/new.webp",
          },
        ],
      },
    });
    const file = new File([new Uint8Array([1])], "room.jpg", { type: "image/jpeg" });

    await roomsService.create({
      name: "Alpine Suite",
      bathroomType: "private",
      maxOccupancy: 2,
      bedType: "1 King Bed",
      images: [{ url: "blob:room-preview", pendingFile: file }],
    });

    expect(mocks.uploadImages).toHaveBeenCalledWith([file], {
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: propertyId,
      propertyId,
      targetResourceId: roomTypeId,
    });
    expect(mocks.put).toHaveBeenCalledWith(
      `/api/pms/properties/${propertyId}/room-types/${roomTypeId}/media`,
      expect.objectContaining({ expectedRoomMediaRevision: 1 }),
      expect.any(Object),
    );
  });

  it("resumes after a committed media write without uploading or writing twice", async () => {
    const mediaObjectId = "33333333-3333-4333-8333-333333333333";
    const item = pmsRoomTypeItem({ roomTypeId, roomMediaRevision: 1 });
    const appliedItem = pmsRoomTypeItem({
      roomTypeId,
      roomMediaRevision: 2,
      media: [{ mediaObjectId, url: "https://cdn.example.com/new.webp" }],
    });
    mocks.uploadImages.mockResolvedValue({
      images: [{ platformMediaObjectId: mediaObjectId, url: "https://cdn.example.com/new.webp" }],
      total: 1,
    });
    let roomRead = 0;
    mocks.get.mockImplementation(async () => {
      roomRead += 1;
      if (roomRead === 1) return { propertyId, item };
      if (roomRead === 2) throw new Error("room refresh interrupted");
      return { propertyId, item: appliedItem };
    });
    mocks.put.mockImplementation(
      putWithAmenities(() => ({ propertyId, roomTypeId, roomMediaRevision: 2 })),
    );
    const file = new File([new Uint8Array([1])], "room.jpg", { type: "image/jpeg" });
    const data = {
      name: "Alpine Suite",
      bathroomType: "private" as const,
      maxOccupancy: 2,
      bedType: "1 King Bed",
      images: [{ url: "blob:room-preview", pendingFile: file }],
    };

    await expect(roomsService.create(data)).rejects.toThrow("room refresh interrupted");
    await expect(roomsService.create(data)).resolves.toMatchObject({
      id: roomTypeId,
      roomMediaRevision: 2,
    });

    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[1]).toEqual(mocks.post.mock.calls[0]);
    expect(mocks.uploadImages).toHaveBeenCalledTimes(1);
    expect(mocks.put.mock.calls.filter(([endpoint]) => endpoint.endsWith("/media"))).toHaveLength(
      1,
    );
  });

  it("retries generated labels that collide elsewhere in the property", async () => {
    const unitIds = [
      "33333333-3333-4333-8333-333333333331",
      "33333333-3333-4333-8333-333333333332",
    ];
    mocks.resolvePropertyId.mockResolvedValue(propertyId.toUpperCase());
    mocks.get
      .mockResolvedValueOnce({
        contractVersion: "pms-room-facts.v1",
        propertyId,
        roomTypeId,
        roomUnitsRevision: 1,
        activeUnitCount: 2,
        capturedAt: canonicalAt,
      })
      .mockResolvedValueOnce({
        items: unitIds.map((roomUnitId) => ({
          contractVersion: "pms-room-facts.v1",
          propertyId,
          roomTypeId,
          roomUnitId,
          lifecycle: "active",
          operationalLabel: null,
          operationalLabelStatus: "unverified",
        })),
      })
      .mockResolvedValueOnce({
        propertyId,
        item: pmsRoomTypeItem({ roomTypeId, name: "Castrop Suite" }),
      });
    let propertyWideLabelConflict = true;
    mocks.put.mockImplementation(
      putWithAmenities(async (endpoint, body) => {
        if (propertyWideLabelConflict && body.operationalLabel === "Castrop Suite 1") {
          propertyWideLabelConflict = false;
          throw new ApiErrorResponse(409, { code: "operational_label_conflict" });
        }
        return {
          contractVersion: "pms-room-facts.v1",
          outcome: "updated",
          propertyId,
          roomTypeId,
          roomUnitId: endpoint.split("/").at(-2),
          roomUnitsRevision: body.expectedRevision + 1,
          operationalLabel: body.operationalLabel,
          operationalLabelStatus: "verified",
          acceptedAt: canonicalAt,
        };
      }),
    );

    await roomsService.create({
      name: "Castrop Suite",
      bathroomType: "private",
      maxOccupancy: 2,
      bedType: "1 King Bed",
      totalRooms: 2,
    });

    expect(
      mocks.put.mock.calls
        .filter(([endpoint]) => endpoint.endsWith("/operational-label"))
        .map(([, body]) => body),
    ).toEqual([
      { expectedRevision: 1, operationalLabel: "Castrop Suite 1" },
      { expectedRevision: 1, operationalLabel: "Castrop Suite 2" },
      { expectedRevision: 2, operationalLabel: "Castrop Suite 3" },
    ]);
  });

  it("replays the room create and resumes generated room labels", async () => {
    const unitIds = [
      "33333333-3333-4333-8333-333333333331",
      "33333333-3333-4333-8333-333333333332",
    ];
    mocks.get.mockImplementation(async (endpoint: string) => {
      if (endpoint.endsWith("/capacity")) {
        return {
          contractVersion: "pms-room-facts.v1",
          propertyId,
          roomTypeId,
          roomUnitsRevision: 1,
          activeUnitCount: 2,
          capturedAt: canonicalAt,
        };
      }
      if (endpoint.endsWith("/units")) {
        return {
          items: unitIds.map((roomUnitId) => ({
            contractVersion: "pms-room-facts.v1",
            propertyId,
            roomTypeId,
            roomUnitId,
            lifecycle: "active",
            operationalLabel: null,
            operationalLabelStatus: "unverified",
          })),
        };
      }
      return { propertyId, item: pmsRoomTypeItem({ roomTypeId, name: "Castrop Suite" }) };
    });
    let labelWrites = 0;
    mocks.put.mockImplementation(
      putWithAmenities(async (endpoint: string, body) => {
        labelWrites += 1;
        if (labelWrites === 2) throw new Error("label write interrupted");
        return {
          contractVersion: "pms-room-facts.v1",
          outcome: "updated",
          propertyId,
          roomTypeId,
          roomUnitId: endpoint.split("/").at(-2),
          roomUnitsRevision: body.expectedRevision + 1,
          operationalLabel: body.operationalLabel,
          operationalLabelStatus: "verified",
          acceptedAt: canonicalAt,
        };
      }),
    );
    const data = {
      name: "Castrop Suite",
      bathroomType: "private" as const,
      maxOccupancy: 2,
      bedType: "1 King Bed",
      totalRooms: 2,
    };

    await expect(roomsService.create(data)).rejects.toThrow("label write interrupted");
    await expect(roomsService.create(data)).resolves.toMatchObject({ id: roomTypeId });

    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[1]).toEqual(mocks.post.mock.calls[0]);
  });

  it("reconciles an uppercase room type ID before verifying the added unit", async () => {
    vi.clearAllMocks();
    const propertyId = "11111111-1111-4111-8111-111111111111";
    const roomTypeId = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
    const canonicalRoomTypeId = roomTypeId.toLowerCase();
    const existingUnitId = "33333333-3333-4333-8333-333333333332";
    const roomUnitId = "33333333-3333-4333-8333-333333333333";
    mocks.resolvePropertyId.mockResolvedValue(propertyId);
    mocks.patch.mockResolvedValue({
      propertyId,
      item: pmsRoomTypeItem({
        roomTypeId: canonicalRoomTypeId,
        name: "Castrop Suite",
        roomCount: 1,
      }),
    });
    mocks.get
      .mockResolvedValueOnce({
        contractVersion: "pms-room-facts.v1",
        propertyId,
        roomTypeId: canonicalRoomTypeId,
        roomUnitsRevision: 4,
        activeUnitCount: 1,
        capturedAt: "2026-09-04T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        items: [
          {
            contractVersion: "pms-room-facts.v1",
            propertyId,
            roomTypeId: canonicalRoomTypeId,
            roomUnitId: existingUnitId,
            lifecycle: "active",
            operationalLabel: "Castrop Suite 1",
            operationalLabelStatus: "verified",
          },
          {
            contractVersion: "pms-room-facts.v1",
            propertyId,
            roomTypeId: canonicalRoomTypeId,
            roomUnitId: "33333333-3333-4333-8333-333333333331",
            lifecycle: "retired",
            operationalLabel: "Castrop Suite 2",
            operationalLabelStatus: "unverified",
          },
          {
            contractVersion: "pms-room-facts.v1",
            propertyId,
            roomTypeId: canonicalRoomTypeId,
            roomUnitId,
            lifecycle: "active",
            operationalLabel: null,
            operationalLabelStatus: "unverified",
          },
        ],
      })
      .mockResolvedValueOnce({
        propertyId,
        item: pmsRoomTypeItem({
          roomTypeId: canonicalRoomTypeId,
          name: "Castrop Suite",
          roomCount: 2,
        }),
      });
    mocks.put
      .mockResolvedValueOnce({
        contractVersion: "pms-room-facts.v1",
        outcome: "reconciled",
        propertyId,
        roomTypeId: canonicalRoomTypeId,
        previousActiveUnitCount: 1,
        capacity: {
          contractVersion: "pms-room-facts.v1",
          propertyId,
          roomTypeId: canonicalRoomTypeId,
          roomUnitsRevision: 5,
          activeUnitCount: 2,
          capturedAt: "2026-09-04T00:00:00.000Z",
        },
        addedUnits: [
          {
            contractVersion: "pms-room-facts.v1",
            propertyId,
            roomTypeId: canonicalRoomTypeId,
            roomUnitId,
            lifecycle: "active",
            operationalLabel: null,
            operationalLabelStatus: "unverified",
          },
        ],
        retiredUnitIds: [],
        acceptedAt: "2026-09-04T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        contractVersion: "pms-room-facts.v1",
        outcome: "updated",
        propertyId,
        roomTypeId: canonicalRoomTypeId,
        roomUnitId,
        roomUnitsRevision: 6,
        operationalLabel: "Castrop Suite 3",
        operationalLabelStatus: "verified",
        acceptedAt: "2026-09-04T00:00:00.000Z",
      });

    const updated = await roomsService.update(roomTypeId, { totalRooms: 2 });

    expect(mocks.put.mock.calls[0]?.[0]).toContain("/physical-units/reconcile");
    expect(mocks.put.mock.calls[0]?.[1]).toEqual({
      expectedRevision: 4,
      targetActiveUnitCount: 2,
    });
    expect(mocks.put.mock.calls[1]?.[1]).toEqual({
      expectedRevision: 5,
      operationalLabel: "Castrop Suite 3",
    });
    expect(updated.totalRooms).toBe(2);
  });

  it("resumes verification without shrinking partially labeled physical capacity", async () => {
    vi.clearAllMocks();
    const propertyId = "11111111-1111-4111-8111-111111111111";
    const roomTypeId = "22222222-2222-4222-8222-222222222222";
    const unitIds = [
      "33333333-3333-4333-8333-333333333331",
      "33333333-3333-4333-8333-333333333332",
      "33333333-3333-4333-8333-333333333333",
    ];
    mocks.resolvePropertyId.mockResolvedValue(propertyId);
    mocks.patch.mockResolvedValue({
      propertyId,
      item: pmsRoomTypeItem({ roomTypeId, name: "Castrop Suite", roomCount: 3 }),
    });
    mocks.get
      .mockResolvedValueOnce({
        contractVersion: "pms-room-facts.v1",
        propertyId,
        roomTypeId,
        roomUnitsRevision: 5,
        activeUnitCount: 3,
        capturedAt: "2026-09-04T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        items: unitIds.map((roomUnitId, index) => ({
          contractVersion: "pms-room-facts.v1",
          propertyId,
          roomTypeId,
          roomUnitId,
          lifecycle: "active",
          operationalLabel: index === 0 ? "Castrop Suite 1" : null,
          operationalLabelStatus: index === 0 ? "verified" : "unverified",
        })),
      })
      .mockResolvedValueOnce({
        propertyId,
        item: pmsRoomTypeItem({ roomTypeId, name: "Castrop Suite", roomCount: 3 }),
      });
    mocks.put.mockImplementation(async (endpoint, body) => ({
      contractVersion: "pms-room-facts.v1",
      outcome: "updated",
      propertyId,
      roomTypeId,
      roomUnitId: endpoint.split("/").at(-2),
      roomUnitsRevision: body.expectedRevision + 1,
      operationalLabel: body.operationalLabel,
      operationalLabelStatus: "verified",
      acceptedAt: "2026-09-04T00:00:00.000Z",
    }));

    await expect(roomsService.update(roomTypeId, { totalRooms: 3 })).resolves.toMatchObject({
      totalRooms: 3,
    });
    expect(
      mocks.put.mock.calls.some(([endpoint]) => endpoint.endsWith("/physical-units/reconcile")),
    ).toBe(false);
    expect(mocks.put.mock.calls.map(([, body]) => body.operationalLabel)).toEqual([
      "Castrop Suite 2",
      "Castrop Suite 3",
    ]);
  });

  it("reduces a generated verified room count through canonical reconciliation", async () => {
    vi.clearAllMocks();
    const propertyId = "11111111-1111-4111-8111-111111111111";
    const roomTypeId = "22222222-2222-4222-8222-222222222222";
    mocks.resolvePropertyId.mockResolvedValue(propertyId);
    mocks.patch.mockResolvedValue({
      propertyId,
      item: pmsRoomTypeItem({ roomTypeId, name: "Castrop Suite", roomCount: 3 }),
    });
    mocks.get
      .mockResolvedValueOnce({
        contractVersion: "pms-room-facts.v1",
        propertyId,
        roomTypeId,
        roomUnitsRevision: 7,
        activeUnitCount: 3,
        capturedAt: "2026-09-04T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        items: [1, 2].map((position) => ({
          contractVersion: "pms-room-facts.v1",
          propertyId,
          roomTypeId,
          roomUnitId: `33333333-3333-4333-8333-33333333333${position}`,
          lifecycle: "active",
          operationalLabel: `Castrop Suite ${position}`,
          operationalLabelStatus: "verified",
        })),
      })
      .mockResolvedValueOnce({
        propertyId,
        item: pmsRoomTypeItem({ roomTypeId, name: "Castrop Suite", roomCount: 2 }),
      });
    mocks.put.mockResolvedValueOnce({
      contractVersion: "pms-room-facts.v1",
      outcome: "reconciled",
      propertyId,
      roomTypeId,
      previousActiveUnitCount: 3,
      capacity: {
        contractVersion: "pms-room-facts.v1",
        propertyId,
        roomTypeId,
        roomUnitsRevision: 8,
        activeUnitCount: 2,
        capturedAt: "2026-09-04T00:00:00.000Z",
      },
      addedUnits: [],
      retiredUnitIds: ["33333333-3333-4333-8333-333333333333"],
      acceptedAt: "2026-09-04T00:00:00.000Z",
    });

    await expect(roomsService.update(roomTypeId, { totalRooms: 2 })).resolves.toMatchObject({
      totalRooms: 2,
    });
    expect(mocks.put).toHaveBeenCalledWith(
      expect.stringContaining("/physical-units/reconcile"),
      { expectedRevision: 7, targetActiveUnitCount: 2 },
      expect.any(Object),
    );
  });
});

describe("linkedInventoryGroupsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePropertyId.mockResolvedValue("pms-property-1");
  });

  it("lists the selected property's linked groups", async () => {
    mocks.get.mockResolvedValue({
      propertyId: "pms-property-1",
      items: [
        {
          groupId: "group-1",
          name: "Convertible suites",
          revision: 2,
          memberRoomTypeIds: ["type-1", "type-2"],
        },
      ],
    });

    await expect(linkedInventoryGroupsService.list()).resolves.toHaveLength(1);
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/pms/properties/pms-property-1/linked-inventory-groups",
      expect.any(Object),
    );
  });

  it("sends create, revisioned replace, and delete commands", async () => {
    const group = {
      groupId: "group-1",
      name: "Convertible suites",
      revision: 2,
      memberRoomTypeIds: ["type-1", "type-2"],
    };
    mocks.post.mockResolvedValue({ group });
    mocks.put.mockResolvedValue({ group: { ...group, revision: 3 } });
    mocks.delete.mockResolvedValue({ group: null });

    await linkedInventoryGroupsService.create(group.name, group.memberRoomTypeIds);
    await linkedInventoryGroupsService.update(group);
    await linkedInventoryGroupsService.delete(group);

    expect(mocks.post).toHaveBeenCalledWith(
      "/api/pms/properties/pms-property-1/linked-inventory-groups",
      expect.objectContaining({
        name: "Convertible suites",
        memberRoomTypeIds: ["type-1", "type-2"],
      }),
      expect.any(Object),
    );
    expect(mocks.put).toHaveBeenCalledWith(
      "/api/pms/properties/pms-property-1/linked-inventory-groups/group-1",
      expect.objectContaining({
        expectedRevision: 2,
        memberRoomTypeIds: ["type-1", "type-2"],
      }),
      expect.any(Object),
    );
    expect(JSON.parse(mocks.delete.mock.calls[0]![1].body)).toMatchObject({
      expectedRevision: 2,
    });
  });

  it("reuses a create command after an ambiguous failure", async () => {
    const group = {
      groupId: "group-retry",
      name: "Retry suites",
      revision: 1,
      memberRoomTypeIds: ["type-1", "type-2"],
    };
    mocks.post.mockRejectedValueOnce(new TypeError("network lost"));
    mocks.post.mockResolvedValueOnce({ group });

    await expect(
      linkedInventoryGroupsService.create(
        ` ${group.name} `,
        [...group.memberRoomTypeIds].reverse(),
      ),
    ).rejects.toThrow("network lost");
    await expect(
      linkedInventoryGroupsService.create(group.name, group.memberRoomTypeIds),
    ).resolves.toEqual(group);

    expect(mocks.post.mock.calls[1]![1].commandId).toBe(mocks.post.mock.calls[0]![1].commandId);
  });
});

describe("individual physical room commands", () => {
  beforeEach(() => vi.clearAllMocks());
  const room = {
    id: "unit-1",
    hotelId: "property-1",
    roomTypeId: "type-1",
    roomUnitsRevision: 4,
    roomNumber: "101",
    roomTypeName: "Suite",
    floor: "1",
    status: "available" as const,
    sortOrder: 1,
    createdAt: "",
    updatedAt: "",
  };
  it("uses the displayed revision and replays an ambiguous update with its original key", async () => {
    mocks.resolvePropertyId.mockResolvedValue("property-1");
    mocks.put.mockRejectedValueOnce(new Error("network interrupted")).mockResolvedValueOnce({});
    await expect(individualRoomsService.update(room, { roomNumber: "102" })).rejects.toThrow(
      "network interrupted",
    );
    await individualRoomsService.update(room, { roomNumber: "102" });
    expect(mocks.put.mock.calls[0]).toEqual(mocks.put.mock.calls[1]);
    expect(mocks.put.mock.calls[0][0]).toBe(
      "/api/pms/properties/property-1/room-types/type-1/physical-units/unit-1",
    );
    expect(mocks.put.mock.calls[0][1]).toEqual({
      expectedRevision: 4,
      changes: { operationalLabel: "102" },
    });
  });
  it("retires only the selected room and preserves structured conflicts", async () => {
    mocks.resolvePropertyId.mockResolvedValue("property-1");
    mocks.delete.mockRejectedValueOnce(new Error("Room is assigned"));
    await expect(individualRoomsService.delete(room)).rejects.toThrow("Room is assigned");
    expect(mocks.delete.mock.calls[0][0]).toContain("/physical-units/unit-1");
    expect(JSON.parse(mocks.delete.mock.calls[0][1].body)).toEqual({ expectedRevision: 4 });
  });
  it("does not send a stale property's room or a room with no revision", async () => {
    mocks.resolvePropertyId.mockResolvedValue("another-property");
    await expect(individualRoomsService.update(room, { roomNumber: "103" })).rejects.toThrow(
      "selected property changed",
    );
    mocks.resolvePropertyId.mockResolvedValue("property-1");
    await expect(
      individualRoomsService.update(
        { ...room, roomUnitsRevision: undefined },
        { roomNumber: "103" },
      ),
    ).rejects.toThrow("out of date");
    expect(mocks.put).not.toHaveBeenCalled();
  });
});
