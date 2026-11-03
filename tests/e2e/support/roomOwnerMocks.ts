import { expect, type Page } from "@playwright/test";

import { corsHeaders, fulfillCorsPreflight } from "./cors";

/**
 * The PMS room authoring APIs a hotel owner's setup calls (room types, units, photos, amenities, facts),
 * answered in memory: the adaptive setup's room step (setup-adaptive-room-authoring) and the four-step setup's
 * first room (setup-four-step-smoke) both drive them. Moved out of the adaptive spec for VAY-2451.
 */
export const ROOM_OWNER_PROPERTY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const ROOM_OWNER_ROOM_TYPE_IDS = [
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
];
const propertyId = ROOM_OWNER_PROPERTY_ID;
const roomTypeIds = ROOM_OWNER_ROOM_TYPE_IDS;
const mediaObjectIds = [
  "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
  "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
];
const now = "2026-08-03T12:00:00.000Z";

export async function mockRoomOwnerApis(page: Page) {
  type OwnerRoom = {
    draftRoomId: string;
    roomTypeId: string;
    facts: Record<string, unknown>;
    roomFactsRevision: number;
    activeUnitCount: number;
    roomUnitIds: string[];
    nextRoomUnitOrdinal: number;
    roomUnitsRevision: number;
    mediaObjectIds: string[];
    roomMediaRevision: number;
    amenities: string[] | null;
    roomAmenitiesRevision: number;
  };
  const rooms = new Map<string, OwnerRoom>();
  const events: string[] = [];
  const createdDraftIds: string[] = [];
  const mediaTargets: string[] = [];
  let draftWrites = 0;
  let draftRevision = 4;
  let sessionRevision = 7;
  let lastDraftRequest: Record<string, unknown> | null = null;
  let lastDraftPayload: Record<string, unknown> | null = null;
  let lastDraftRoomId: string | null = null;

  // The old room-create route was removed (VAY-2387); room setup must not call this path.
  await page.route(/\/api\/pms\/properties\/[^/]+\/room-types(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    events.push(`retired-room-route:${route.request().method()}`);
    await route.fulfill({ status: 404, headers: corsHeaders(route) });
  });
  await page.route(/\/api\/pms\/properties\/[^/]+\/plan-limits$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        contractVersion: "pms-operations.v1",
        propertyId,
        propertyPlan: {
          propertyId,
          plan: "commission",
          limits: {
            maxRoomPhotosPerType: 10,
            maxAddons: 3,
            guestContactAccess: "after_acceptance",
          },
        },
      },
    });
  });

  await page.route(/\/api\/hotel-setup\/properties\/[^/]+\/setup-drafts\/rooms$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    const body = route.request().postDataJSON() as { payload: Record<string, unknown> };
    events.push("draft");
    draftWrites += 1;
    draftRevision += 1;
    sessionRevision += 1;
    lastDraftRequest = body;
    lastDraftPayload = body.payload;
    lastDraftRoomId =
      Object.keys((body.payload["room.name"] as Record<string, unknown>) ?? {})[0] ?? null;
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        contractVersion: "property-setup-draft.v1",
        sessionId: "22222222-2222-4222-8222-222222222222",
        stepId: "rooms",
        selectedTracks: ["hotel_operations"],
        trackRevision: 3,
        sessionRevision,
        draftRevision,
        retentionExpiresAt: "2026-11-01T00:00:00.000Z",
        updatedAt: now,
        replayed: false,
      },
    });
  });

  await page.route(/\/api\/pms\/setup\/properties\/[^/]+\/room-types(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        // As the API answers (pms-room-facts.v1); the onboarding pricing workspace checks the version.
        json: {
          contractVersion: "pms-room-facts.v1",
          propertyId,
          items: [...rooms.values()].map(factsSnapshot),
        },
      });
      return;
    }
    const body = route.request().postDataJSON() as {
      draftRoomId: string;
      facts: Record<string, unknown>;
    };
    let room = rooms.get(body.draftRoomId);
    if (!room) {
      const index = rooms.size;
      room = {
        draftRoomId: body.draftRoomId,
        roomTypeId: roomTypeIds[index]!,
        facts: body.facts,
        roomFactsRevision: 1,
        activeUnitCount: 0,
        roomUnitIds: [],
        nextRoomUnitOrdinal: 1,
        roomUnitsRevision: 1,
        mediaObjectIds: [],
        roomMediaRevision: 1,
        amenities: null,
        roomAmenitiesRevision: 1,
      };
      rooms.set(body.draftRoomId, room);
      createdDraftIds.push(body.draftRoomId);
    }
    events.push("facts:create");
    expect(route.request().headers()["idempotency-key"]).toBe(
      `room-create:${propertyId}:${body.draftRoomId}`,
    );
    await route.fulfill({
      status: 201,
      headers: corsHeaders(route),
      json: {
        contractVersion: "pms-room-facts.v1",
        outcome: "created",
        roomType: factsSnapshot(room),
        draftRoomBinding: {
          propertyId,
          draftRoomId: body.draftRoomId,
          roomTypeId: room.roomTypeId,
        },
        acceptedAt: now,
      },
    });
  });

  await page.route(
    /\/api\/pms\/setup\/properties\/[^/]+\/room-type-bindings\/([^/?]+)$/,
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      const draftId = decodeURIComponent(
        new URL(route.request().url()).pathname.split("/").at(-1)!,
      );
      const room = rooms.get(draftId);
      await route.fulfill(
        room
          ? {
              status: 200,
              headers: corsHeaders(route),
              json: { propertyId, draftRoomId: draftId, roomTypeId: room.roomTypeId },
            }
          : { status: 404, headers: corsHeaders(route), json: { detail: "Binding not found" } },
      );
    },
  );

  await page.route(
    /\/api\/pms\/setup\/properties\/[^/]+\/room-types\/([^/]+)\/capacity$/,
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      const room = roomByType(rooms, route.request().url());
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: capacitySnapshot(room),
      });
    },
  );

  await page.route(
    /\/api\/pms\/setup\/properties\/[^/]+\/room-types\/([^/]+)\/physical-units\/reconcile$/,
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      const room = roomByType(rooms, route.request().url(), 2);
      const body = route.request().postDataJSON() as { targetActiveUnitCount: number };
      const previous = room.activeUnitCount;
      const retiredUnitIds =
        body.targetActiveUnitCount < previous
          ? room.roomUnitIds.splice(body.targetActiveUnitCount)
          : [];
      const addedUnitIds = Array.from(
        { length: Math.max(0, body.targetActiveUnitCount - previous) },
        (_, index) =>
          `eeeeeeee-eeee-4eee-8eee-${String(
            roomTypeIds.indexOf(room.roomTypeId) * 100 + room.nextRoomUnitOrdinal + index,
          ).padStart(12, "0")}`,
      );
      room.roomUnitIds.push(...addedUnitIds);
      room.nextRoomUnitOrdinal += addedUnitIds.length;
      room.activeUnitCount = room.roomUnitIds.length;
      room.roomUnitsRevision += 1;
      events.push("units:reconcile");
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          contractVersion: "pms-room-facts.v1",
          outcome: "reconciled",
          propertyId,
          roomTypeId: room.roomTypeId,
          previousActiveUnitCount: previous,
          capacity: capacitySnapshot(room),
          addedUnits: addedUnitIds.map((roomUnitId) => ({
            contractVersion: "pms-room-facts.v1",
            propertyId,
            roomTypeId: room.roomTypeId,
            roomUnitId,
            lifecycle: "active",
            operationalLabel: null,
            operationalLabelStatus: "unverified",
          })),
          retiredUnitIds,
          acceptedAt: now,
        },
      });
    },
  );

  await page.route(
    /\/api\/pms\/setup\/properties\/[^/]+\/room-types\/([^/]+)\/units$/,
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      const room = roomByType(rooms, route.request().url());
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          items: room.roomUnitIds.map((roomUnitId) => ({
            contractVersion: "pms-room-facts.v1",
            propertyId,
            roomTypeId: room.roomTypeId,
            roomUnitId,
            lifecycle: "active",
            operationalLabel: null,
            operationalLabelStatus: "unverified",
          })),
        },
      });
    },
  );

  await page.route(
    /\/api\/pms\/properties\/[^/]+\/room-types\/([^/]+)\/physical-units\/([^/]+)\/operational-label$/,
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      const room = roomByType(rooms, route.request().url(), 3);
      const roomUnitId = new URL(route.request().url()).pathname.split("/").at(-2)!;
      const body = route.request().postDataJSON() as {
        expectedRevision: number;
        operationalLabel: string;
      };
      room.roomUnitsRevision = body.expectedRevision + 1;
      events.push("units:label");
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          contractVersion: "pms-room-facts.v1",
          outcome: "updated",
          propertyId,
          roomTypeId: room.roomTypeId,
          roomUnitId,
          roomUnitsRevision: room.roomUnitsRevision,
          operationalLabel: body.operationalLabel,
          operationalLabelStatus: "verified",
          acceptedAt: now,
        },
      });
    },
  );

  await page.route(/\/api\/pms\/properties\/[^/]+\/room-types\/([^/]+)\/media$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    const room = roomByType(rooms, route.request().url());
    const body = route.request().postDataJSON() as {
      assignments: Array<{ mediaObjectId: string }>;
    };
    room.mediaObjectIds = body.assignments.map(({ mediaObjectId }) => mediaObjectId);
    room.roomMediaRevision += 1;
    events.push("media:assign");
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        contractVersion: "pms-room-publication.v1",
        outcome: "assigned",
        propertyId,
        roomTypeId: room.roomTypeId,
        roomMediaRevision: room.roomMediaRevision,
        assignments: body.assignments,
        acceptedAt: now,
      },
    });
  });

  await page.route(
    /\/api\/pms\/properties\/[^/]+\/room-types\/([^/]+)\/amenities$/,
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      const room = roomByType(rooms, route.request().url());
      const body = route.request().postDataJSON() as { amenities: string[] };
      room.amenities = body.amenities;
      room.roomAmenitiesRevision += 1;
      events.push(body.amenities.length === 0 ? "amenities:confirm-empty" : "amenities:confirm");
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          contractVersion: "pms-room-amenities.v1",
          outcome: "confirmed",
          roomAmenities: {
            contractVersion: "pms-room-amenities.v1",
            propertyId,
            roomTypeId: room.roomTypeId,
            roomAmenitiesRevision: room.roomAmenitiesRevision,
            reviewed: true,
            amenities: body.amenities,
            reviewedAt: now,
          },
          acceptedAt: now,
        },
      });
    },
  );

  await page.route(/\/api\/pms\/setup\/properties\/[^/]+\/room-types\/([^/?]+)$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    const room = roomByType(rooms, route.request().url(), 0);
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, headers: corsHeaders(route), json: factsSnapshot(room) });
      return;
    }
    if (route.request().method() === "DELETE") {
      rooms.delete(room.draftRoomId);
      events.push("room:delete");
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          contractVersion: "pms-room-facts.v1",
          outcome: "deleted",
          propertyId,
          roomTypeId: room.roomTypeId,
          lifecycle: "inactive",
          deletedRevision: room.roomFactsRevision + 1,
          acceptedAt: now,
        },
      });
      return;
    }
    throw new Error(`Unexpected room facts method ${route.request().method()}`);
  });

  await page.route(/\/api\/pms\/properties\/[^/]+\/room-publication-snapshot$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        contractVersion: "pms-room-publication.v1",
        propertyId,
        rooms: [...rooms.values()].map(publicationRoom),
      },
    });
  });

  await page.route(/\/api\/media\/upload-sessions(?:\/[^/]+\/finalize)?$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    if (new URL(route.request().url()).pathname.endsWith("/finalize")) {
      const target = mediaTargets.at(-1)!;
      const mediaObjectId = mediaObjectIds[roomTypeIds.indexOf(target)]!;
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          contractVersion: "platform-media-upload.v2",
          mediaObjects: [
            {
              mediaObjectId,
              purpose: "pms.room_type.media",
              status: "private_ready",
              publicVariants: [],
            },
          ],
        },
      });
      return;
    }
    const body = route.request().postDataJSON() as { resource: { targetResourceId: string } };
    expect(body.resource.targetResourceId).not.toMatch(/^draft:/);
    mediaTargets.push(body.resource.targetResourceId);
    await route.fulfill({
      status: 201,
      headers: corsHeaders(route),
      json: {
        contractVersion: "platform-media-upload.v2",
        uploadSession: { sessionId: `upload-${mediaTargets.length}`, status: "signed" },
        uploadTargets: [
          {
            uploadTargetId: `target-${mediaTargets.length}`,
            clientFileId: "file_1",
            method: "PUT",
            uploadUrl: "https://uploads.vayada.localhost/room.jpg",
            headers: { "content-type": "image/jpeg" },
          },
        ],
      },
    });
  });

  return {
    insertImportedRoom() {
      rooms.set(roomTypeIds[0]!, {
        ...ownerRoomShape(),
        roomTypeId: roomTypeIds[0]!,
        draftRoomId: "import:synthetic-source:garden",
        facts: {
          name: "Imported Suite",
          description: "",
          category: null,
          occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
          beds: [{ type: "queen", quantity: 1 }],
          bedrooms: null,
          bathrooms: null,
          bathroomType: "private",
          size: null,
        },
      });
    },
    events,
    createdDraftIds,
    mediaTargets,
    get draftWrites() {
      return draftWrites;
    },
    get lastDraftRequest() {
      return lastDraftRequest;
    },
    get lastDraftPayload() {
      return lastDraftPayload;
    },
    get lastDraftRoomId() {
      return lastDraftRoomId;
    },
  };
}

function roomByType(rooms: Map<string, { roomTypeId: string }>, url: string, trailingSegments = 1) {
  const segments = new URL(url).pathname.split("/");
  const roomTypeId = segments.at(-1 - trailingSegments)!;
  const room = [...rooms.values()].find((candidate) => candidate.roomTypeId === roomTypeId);
  if (!room) throw new Error(`Unknown room type ${roomTypeId}`);
  return room as ReturnType<typeof ownerRoomShape>;
}

function ownerRoomShape() {
  return {
    draftRoomId: "",
    roomTypeId: "",
    facts: {} as Record<string, unknown>,
    roomFactsRevision: 1,
    activeUnitCount: 0,
    roomUnitIds: [] as string[],
    nextRoomUnitOrdinal: 1,
    roomUnitsRevision: 1,
    mediaObjectIds: [] as string[],
    roomMediaRevision: 1,
    amenities: null as string[] | null,
    roomAmenitiesRevision: 1,
  };
}

function factsSnapshot(room: ReturnType<typeof ownerRoomShape>) {
  return {
    contractVersion: "pms-room-facts.v1",
    propertyId,
    roomTypeId: room.roomTypeId,
    roomFactsRevision: room.roomFactsRevision,
    lifecycle: "active",
    facts: room.facts,
    createdAt: now,
    updatedAt: now,
  };
}

function capacitySnapshot(room: ReturnType<typeof ownerRoomShape>) {
  return {
    contractVersion: "pms-room-facts.v1",
    propertyId,
    roomTypeId: room.roomTypeId,
    roomUnitsRevision: room.roomUnitsRevision,
    activeUnitCount: room.activeUnitCount,
    capturedAt: now,
  };
}

function publicationRoom(room: ReturnType<typeof ownerRoomShape>) {
  return {
    propertyId,
    roomTypeId: room.roomTypeId,
    facts: room.facts,
    activeUnitCount: room.activeUnitCount,
    media: room.mediaObjectIds.map((mediaObjectId, sortOrder) => ({
      mediaObjectId,
      altText: `Room photo ${sortOrder + 1}`,
      sortOrder,
      publicVariants: [
        {
          variantName: "thumbnail",
          publicUrl: `https://media.example/${mediaObjectId}/thumbnail.webp`,
        },
      ],
    })),
    amenities: room.amenities,
    sourceRevisions: {
      roomFactsRevision: room.roomFactsRevision,
      roomUnitsRevision: room.roomUnitsRevision,
      roomMediaRevision: room.roomMediaRevision,
      roomAmenitiesRevision: room.roomAmenitiesRevision,
    },
  };
}
