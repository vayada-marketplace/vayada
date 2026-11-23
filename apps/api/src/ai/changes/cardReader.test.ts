// The card's reads (VAY-2524) through the app's real read routes and auth, on fake storage: what
// each route answers today is what the card reader parses, as the person who answers, with their
// own rights and property scope.
import { createFakeVerifier, type PermissionKey } from "@vayada/backend-auth";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../../app.js";
import type { PmsInboxReadPort } from "../../domains/pmsInbox.js";
import type { PmsOperationsReadRepository } from "../../domains/pmsOperationsReadModel.js";
import { WORLD, worldAuthorization } from "../actions/actionTestWorld.fixtures.js";
import { createCardReader } from "./cardReader.js";
import { CardReadError } from "./changeCard.js";

const { OWNER, MEMBER, P1, P2 } = WORLD;
const DELUXE = "eeeeeeee-0000-4000-8000-000000000001";
const SUITE = "eeeeeeee-0000-4000-8000-000000000002";
const R12 = "ffffffff-0000-4000-8000-000000000012";
const BLOCK = "abababab-0000-4000-8000-000000000001";
const THREAD = "acacacac-0000-4000-8000-000000000001";
const BOOKING = "adadadad-0000-4000-8000-000000000001";
const READS: PermissionKey[] = [
  "pms.room_status.read",
  "pms.rooms_rates.read",
  "pms.calendar.read",
  "pms.operations.read",
  "pms.inbox.read",
  "pms.reservation.read",
];

const repository = {
  async listRoomsByPropertyId() {
    return {
      items: [
        {
          roomId: R12,
          roomTypeId: DELUXE,
          roomNumber: "12",
          floor: "1",
          status: "available",
          sortOrder: 1,
          metadata: {},
        },
      ],
    };
  },
  async listRoomTypesByPropertyId() {
    return { items: [{ roomTypeId: DELUXE, name: "Deluxe Double" }] };
  },
  async listLinkedInventoryGroupsByPropertyId() {
    return {
      items: [{ groupId: "g1", name: "Shared", revision: 1, memberRoomTypeIds: [DELUXE, SUITE] }],
    };
  },
  async listRoomBlocksByPropertyId() {
    return {
      items: [
        {
          blockId: BLOCK,
          version: "3",
          roomTypeId: DELUXE,
          roomId: R12,
          startsOn: "2026-12-12",
          endsOn: "2026-12-14",
          blockedCount: 1,
          reason: "staff text",
          status: "active",
        },
      ],
    };
  },
  async findReservationByGuestBookingId(_propertyId: string, guestBookingId: string) {
    if (guestBookingId !== BOOKING) return null;
    return {
      guestBookingId,
      bookingReference: "VAY-1042",
      status: "confirmed",
      source: "pms",
      stay: { checkIn: "2026-12-12", checkOut: "2026-12-15", adults: 2, children: 0 },
      primaryGuest: {
        displayName: "Anna Keller",
        email: "anna@example.test",
        phone: null,
        countryCode: null,
        specialRequests: null,
        countryCodeRaw: null,
        countryCodeReviewRequired: false,
      },
      addOns: [],
      assignments: [],
      checkin: { completedAt: null, pendingFlags: [] },
      checkout: { completedAt: null, pendingFlags: [] },
      privateNoteCount: 0,
      additionalGuestCount: 0,
    };
  },
} as unknown as PmsOperationsReadRepository;

const inbox = {
  async getThread({ propertyId, threadId }: { propertyId: string; threadId: string }) {
    if (threadId !== THREAD) return { ok: false, error: { code: "thread_not_found" } };
    return {
      ok: true,
      value: {
        propertyId,
        thread: {
          id: threadId,
          version: 4,
          attentionState: "needs_attention",
          followUpAt: null,
          assignedTo: null,
          channel: "ota",
          providerChannel: "airbnb",
          guest: { displayName: "Anna Keller" },
          conversationContext: { state: "unlinked" },
          unreadCount: 1,
          activityAt: "2026-12-09T08:00:00.000Z",
          lastMessage: { preview: null, at: "2026-12-09T08:00:00.000Z", hasAttachments: false },
          replyRoute: { kind: "none" },
        },
        availableProviderActions: [],
        timeline: [],
        previousCursor: null,
      },
    };
  },
} as unknown as PmsInboxReadPort;

const session = (user: string) => ({
  workosUserId: `wos_${user}`,
  workosOrgId: "org_wos_a",
  sessionId: `session_${user}`,
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});

let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function readerAs(user: string, permissions: PermissionKey[] = READS) {
  const world = worldAuthorization(permissions);
  app = buildApp({
    logger: false,
    pmsOperationsRepository: repository,
    pmsInboxReadPort: inbox,
    auth: {
      ...world.auth,
      verifier: createFakeVerifier(new Map([[user, session(user)]])),
    },
  });
  await app.ready();
  return createCardReader(app, `Bearer ${user}`);
}

describe("the card's reads, as the person (VAY-2524)", () => {
  it("reads rooms, room types, linked room types, blocks, a conversation and a booking", async () => {
    const reader = await readerAs(OWNER);
    expect(await reader.rooms(P1)).toEqual([
      { roomId: R12, roomTypeId: DELUXE, roomNumber: "12", status: "available" },
    ]);
    expect(await reader.roomTypeNames(P1)).toEqual(new Map([[DELUXE, "Deluxe Double"]]));
    expect(await reader.linkedRoomTypeIds(P1, DELUXE.toUpperCase())).toEqual([SUITE]);
    expect(await reader.roomBlock(P1, BLOCK)).toMatchObject({
      roomId: R12,
      startsOn: "2026-12-12",
      endsOn: "2026-12-14",
      status: "active",
    });
    expect(await reader.roomBlock(P1, "abababab-0000-4000-8000-000000000099")).toBeNull();
    expect(await reader.thread(P1, THREAD)).toEqual({
      guestName: "Anna Keller",
      channel: "ota",
      providerChannel: "airbnb",
      lastMessageAt: "2026-12-09T08:00:00.000Z",
    });
    expect(await reader.booking(P1, BOOKING)).toEqual({
      guestName: "Anna Keller",
      reference: "VAY-1042",
      checkIn: "2026-12-12",
      checkOut: "2026-12-15",
    });
    // Gone: the card closes the question as "changed".
    expect(await reader.booking(P1, "adadadad-0000-4000-8000-000000000099")).toBeNull();
  });

  it("reads only what the person may read", async () => {
    // The member may use P1 only.
    const member = await readerAs(MEMBER);
    await expect(member.rooms(P2)).rejects.toThrow(CardReadError);
    await expect(member.rooms(P2)).rejects.toMatchObject({ reason: "not_allowed" });
    await app!.close();
    app = undefined;
    const withoutRooms = await readerAs(
      OWNER,
      READS.filter((key) => key !== "pms.room_status.read"),
    );
    await expect(withoutRooms.rooms(P1)).rejects.toMatchObject({ reason: "not_allowed" });
  });

  it("is nobody without the person's token", async () => {
    await readerAs(OWNER);
    const nobody = createCardReader(app!, "Bearer someone-else");
    await expect(nobody.rooms(P1)).rejects.toMatchObject({ reason: "not_allowed" });
  });
});
