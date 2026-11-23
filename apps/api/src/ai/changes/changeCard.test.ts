// The Yes/No card's text (VAY-2524): written by vayada from the stored change and the records it
// names, for every change action there is.
import { describe, expect, it } from "vitest";

import { CHANGE_ACTIONS } from "../actions/registry.js";
import {
  CARD_WRITERS,
  CardReadError,
  CardTargetMissingError,
  cardSha256,
  changeArgumentProblem,
  dateTimeText,
  listText,
  nightsText,
  writeChangeCard,
  type CardReader,
  type CardRoomBlock,
} from "./changeCard.js";

const P = "cccccccc-0000-4000-8000-000000000001";
const DELUXE = "eeeeeeee-0000-4000-8000-000000000001";
const SUITE = "eeeeeeee-0000-4000-8000-000000000002";
const R12 = "ffffffff-0000-4000-8000-000000000012";
const R14 = "ffffffff-0000-4000-8000-000000000014";
const BLOCK = "abababab-0000-4000-8000-000000000001";
const THREAD = "acacacac-0000-4000-8000-000000000001";
const BOOKING = "adadadad-0000-4000-8000-000000000001";
const NOW = new Date("2026-12-09T09:40:00Z");

function reader(overrides: Partial<CardReader> = {}): CardReader {
  return {
    async rooms() {
      return [
        { roomId: R12, roomTypeId: DELUXE, roomNumber: "12", status: "available" },
        { roomId: R14, roomTypeId: DELUXE, roomNumber: "14", status: "maintenance" },
      ];
    },
    async roomTypeNames() {
      return new Map([
        [DELUXE, "Deluxe Double"],
        [SUITE, "Garden Suite"],
      ]);
    },
    async roomBlock(): Promise<CardRoomBlock | null> {
      return {
        roomTypeId: DELUXE,
        roomId: R12,
        startsOn: "2026-12-12",
        endsOn: "2026-12-14",
        blockedCount: 1,
        status: "active",
      };
    },
    async linkedRoomTypeIds() {
      return [];
    },
    async thread() {
      return {
        guestName: "Anna Keller",
        channel: "ota" as const,
        providerChannel: "Airbnb",
        lastMessageAt: "2026-12-09T08:00:00.000Z",
      };
    },
    async booking() {
      return {
        guestName: "Anna Keller",
        reference: "VAY-1042",
        checkIn: "2026-12-12",
        checkOut: "2026-12-15",
      };
    },
    ...overrides,
  };
}

const write = (action: string, args: Record<string, unknown>, read = reader(), waiting = true) =>
  writeChangeCard(action, { propertyId: P, arguments: args, reader: read, now: NOW, waiting });

describe("the Yes/No card (VAY-2524)", () => {
  it("has a card for every change action, so none is ever asked without one", () => {
    expect(CHANGE_ACTIONS.map((action) => action.key).sort()).toEqual(
      Object.keys(CARD_WRITERS).sort(),
    );
  });

  it("writes nights and lists the way people read them", () => {
    expect(nightsText("2026-12-12", "2026-12-14", NOW)).toBe("Sat 12, Sun 13 and Mon 14 Dec");
    expect(nightsText("2026-11-30", "2026-12-01", NOW)).toBe("Mon 30 Nov and Tue 1 Dec");
    expect(nightsText("2026-12-31", "2027-01-01", NOW)).toBe("Thu 31 Dec and Fri 1 Jan 2027");
    expect(nightsText("2026-12-12", "2026-12-12", NOW)).toBe("Sat 12 Dec");
    // More than a week: from and to, with the year when it is not this year.
    expect(nightsText("2026-12-20", "2027-01-02", NOW)).toBe("Sun 20 Dec to Sat 2 Jan 2027");
    expect(dateTimeText("2026-12-14T09:00:00.000Z", NOW)).toBe("Mon 14 Dec, 09:00 UTC");
    expect(listText(["1"])).toBe("1");
    expect(listText(["1", "2"])).toBe("1 and 2");
    expect(listText(["1", "2", "3", "4", "5", "6", "7"])).toBe("1, 2, 3, 4 and 3 more");
    // A last night before the first is no change anyone asked for.
    expect(() => nightsText("2026-12-14", "2026-12-12", NOW)).toThrow(CardTargetMissingError);
  });

  it("blocks rooms: which rooms, which nights, why, and what else happens", async () => {
    const args = {
      propertyId: P,
      roomTypeId: DELUXE,
      roomIds: [R12],
      startsOn: "2026-12-12",
      endsOn: "2026-12-14",
      reason: "Maintenance: shower repair",
    };
    expect(await write("room_block_create@1", args)).toEqual({
      question: "Block room 12 for 3 nights?",
      doneTitle: "Blocked room 12 for 3 nights",
      yesLabel: "Yes, block room 12",
      details: [
        { label: "Room", value: "12 · Deluxe Double" },
        { label: "Nights", value: "Sat 12, Sun 13 and Mon 14 Dec" },
        { label: "Reason", value: "Maintenance: shower repair" },
      ],
      effects: [
        "Guests can't book room 12 on these nights.",
        "If channels are connected, they get the new availability.",
      ],
    });
    const two = await write("room_block_create@1", {
      ...args,
      roomIds: [R12, R14],
      endsOn: "2026-12-12",
      reason: undefined,
    });
    expect(two).toMatchObject({
      question: "Block rooms 12 and 14 for 1 night?",
      yesLabel: "Yes, block 2 rooms",
      details: [
        { label: "Rooms", value: "12 and 14 · Deluxe Double" },
        { label: "Nights", value: "Sat 12 Dec" },
      ],
    });
    // A room named twice is blocked once (the route removes the repeat), in any letter case.
    expect(
      await write("room_block_create@1", {
        ...args,
        roomTypeId: DELUXE.toUpperCase(),
        roomIds: [R12, R12.toUpperCase()],
      }),
    ).toMatchObject({ question: "Block room 12 for 3 nights?", yesLabel: "Yes, block room 12" });
    // Room types that share rooms with this one are named.
    expect(
      await write("room_block_create@1", args, reader({ linkedRoomTypeIds: async () => [SUITE] })),
    ).toMatchObject({
      effects: [
        "Guests can't book room 12 on these nights.",
        "Linked room types share these rooms, so their availability changes too: Garden Suite.",
        "If channels are connected, they get the new availability.",
      ],
    });
    // The linked line never makes a card unanswerable: groups the person can't read, or a type
    // whose name can't be read, give the line without names; a failed read still fails.
    const effectsWith = async (linked: Partial<CardReader>) =>
      (await write("room_block_create@1", args, reader(linked))).effects;
    expect(
      await effectsWith({
        linkedRoomTypeIds: async () => {
          throw new CardReadError("not_allowed");
        },
      }),
    ).toContain("If linked room types share these rooms, their availability changes too.");
    expect(
      await effectsWith({
        linkedRoomTypeIds: async () => ["eeeeeeee-0000-4000-8000-000000000099"],
      }),
    ).toContain("Linked room types share these rooms, so their availability changes too.");
    await expect(
      effectsWith({
        linkedRoomTypeIds: async () => {
          throw new CardReadError("unavailable");
        },
      }),
    ).rejects.toMatchObject({ reason: "unavailable" });
    // A last night before the first is refused when the AI asks, never shown.
    expect(changeArgumentProblem("room_block_create@1", { ...args, endsOn: "2026-12-11" })).toBe(
      "endsOn: must not be before startsOn",
    );
    expect(changeArgumentProblem("room_block_create@1", args)).toBeNull();
    // A room that is gone, or not of that room type: the change is no longer what was asked.
    await expect(
      write("room_block_create@1", { ...args, roomIds: ["ffffffff-0000-4000-8000-000000000099"] }),
    ).rejects.toThrow(CardTargetMissingError);
    await expect(write("room_block_create@1", { ...args, roomTypeId: SUITE })).rejects.toThrow(
      CardTargetMissingError,
    );
  });

  it("releases a block, of one room or of some rooms of a room type", async () => {
    const args = { propertyId: P, blockId: BLOCK, expectedVersion: "3" };
    expect(await write("room_block_release@1", args)).toEqual({
      question: "Release the block on room 12 for 3 nights?",
      doneTitle: "Released the block on room 12 for 3 nights",
      yesLabel: "Yes, release the block",
      details: [
        { label: "Room", value: "12 · Deluxe Double" },
        { label: "Nights", value: "Sat 12, Sun 13 and Mon 14 Dec" },
      ],
      effects: [
        "Guests can book room 12 on these nights again.",
        "If channels are connected, they get the new availability.",
      ],
    });
    const typeBlock: CardRoomBlock = {
      roomTypeId: SUITE,
      roomId: null,
      startsOn: "2026-12-12",
      endsOn: "2026-12-12",
      blockedCount: 2,
      status: "active",
    };
    expect(
      await write("room_block_release@1", args, reader({ roomBlock: async () => typeBlock })),
    ).toMatchObject({
      question: "Release the block on 2 rooms of Garden Suite for 1 night?",
      details: [{ label: "Rooms", value: "2 rooms of Garden Suite" }, expect.anything()],
    });
    // Released meanwhile: nothing left to release while it waits; its title still reads after.
    const released = reader({ roomBlock: async () => ({ ...typeBlock, status: "released" }) });
    await expect(write("room_block_release@1", args, released)).rejects.toThrow(
      CardTargetMissingError,
    );
    expect(await write("room_block_release@1", args, released, false)).toMatchObject({
      doneTitle: "Released the block on 2 rooms of Garden Suite for 1 night",
    });
    await expect(
      write("room_block_release@1", args, reader({ roomBlock: async () => null })),
    ).rejects.toThrow(CardTargetMissingError);
    // However long the block, the card counts every night and names the real last one.
    const long = reader({
      roomBlock: async () => ({ ...typeBlock, startsOn: "2026-01-01", endsOn: "2027-12-31" }),
    });
    expect(await write("room_block_release@1", args, long)).toMatchObject({
      question: "Release the block on 2 rooms of Garden Suite for 730 nights?",
      details: [expect.anything(), { label: "Nights", value: "Thu 1 Jan to Fri 31 Dec 2027" }],
    });
  });

  it("sets a room's state, saying what it is now", async () => {
    const args = {
      propertyId: P,
      roomTypeId: DELUXE,
      roomUnitId: R14,
      expectedRevision: 7,
      changes: { status: "available" },
    };
    expect(await write("room_status_set@1", args)).toEqual({
      question: "Set room 14 to available?",
      doneTitle: "Set room 14 to available",
      yesLabel: "Yes, set it to available",
      details: [
        { label: "Room", value: "14 · Deluxe Double" },
        { label: "Now", value: "maintenance" },
        { label: "New", value: "available" },
      ],
      effects: ["Guests can be given room 14 again.", "Bookings and prices don't change."],
    });
    expect(
      await write("room_status_set@1", {
        ...args,
        roomUnitId: R12,
        changes: { status: "out_of_order" },
      }),
    ).toMatchObject({
      question: "Set room 12 to out of order?",
      effects: ["Guests can't be given room 12 while it is out of order.", expect.any(String)],
    });
  });

  it("sorts a guest conversation, telling that the guest is not told", async () => {
    const args = { propertyId: P, threadId: THREAD, expectedThreadVersion: 4 };
    expect(await write("thread_mark_done@1", args)).toEqual({
      question: "Mark the conversation with Anna Keller as done?",
      doneTitle: "Marked the conversation with Anna Keller as done",
      yesLabel: "Yes, mark it done",
      details: [
        { label: "Guest", value: "Anna Keller" },
        { label: "Channel", value: "Airbnb" },
        { label: "Last message", value: "Wed 9 Dec, 08:00 UTC" },
      ],
      effects: [
        "It leaves the list of conversations that need an answer.",
        "The guest is not told.",
      ],
    });
    expect(
      await write("thread_follow_up@1", { ...args, followUpAt: "2026-12-14T09:00:00.000Z" }),
    ).toMatchObject({
      question: "Set the conversation with Anna Keller aside until Mon 14 Dec, 09:00 UTC?",
      details: [
        { label: "Guest", value: "Anna Keller" },
        { label: "Channel", value: "Airbnb" },
        { label: "Last message", value: "Wed 9 Dec, 08:00 UTC" },
        { label: "Until", value: "Mon 14 Dec, 09:00 UTC" },
      ],
    });
    const unnamed = reader({
      thread: async () => ({
        guestName: null,
        channel: "email",
        providerChannel: null,
        lastMessageAt: null,
      }),
    });
    expect(await write("thread_reopen@1", args, unnamed)).toMatchObject({
      question: "Open a guest conversation again?",
      details: [
        { label: "Guest", value: "Name not known" },
        { label: "Channel", value: "Email" },
      ],
    });
    await expect(
      write("thread_mark_done@1", args, reader({ thread: async () => null })),
    ).rejects.toThrow(CardTargetMissingError);
  });

  it("adds a private note, showing the note itself", async () => {
    const args = { propertyId: P, guestBookingId: BOOKING, body: "  Late arrival, keep room 12. " };
    expect(await write("booking_note_add@1", args)).toEqual({
      question: "Add a private note to Anna Keller's booking?",
      doneTitle: "Added a private note to Anna Keller's booking",
      yesLabel: "Yes, add the note",
      details: [
        { label: "Booking", value: "VAY-1042 · 3 nights from Sat 12 Dec" },
        { label: "Note", value: "Late arrival, keep room 12." },
      ],
      effects: ["Only your team sees the note; the guest never does."],
    });
    const sameDay = reader({
      booking: async () => ({
        guestName: "",
        reference: "VAY-1043",
        checkIn: "2026-12-12",
        checkOut: "2026-12-12",
      }),
    });
    expect(await write("booking_note_add@1", args, sameDay)).toMatchObject({
      question: "Add a private note to booking VAY-1043?",
      details: [{ label: "Booking", value: "VAY-1043 · from Sat 12 Dec" }, expect.anything()],
    });
  });

  it("binds a Yes to the card's exact text, its operation and its preview", async () => {
    const args = { propertyId: P, threadId: THREAD, expectedThreadVersion: 4 };
    const card = await write("thread_mark_done@1", args);
    const renamed = await write(
      "thread_mark_done@1",
      args,
      reader({
        thread: async () => ({
          guestName: "Anna Keller-Brandt",
          channel: "ota",
          providerChannel: "Airbnb",
          lastMessageAt: "2026-12-09T08:00:00.000Z",
        }),
      }),
    );
    const op = { id: "11111111-0000-4000-8000-000000000001", previewSha256: null };
    expect(cardSha256(op, card)).toBe(cardSha256(op, await write("thread_mark_done@1", args)));
    expect(cardSha256(op, renamed)).not.toBe(cardSha256(op, card));
    expect(cardSha256({ ...op, id: "11111111-0000-4000-8000-000000000002" }, card)).not.toBe(
      cardSha256(op, card),
    );
    expect(cardSha256({ ...op, previewSha256: "a".repeat(64) }, card)).not.toBe(
      cardSha256(op, card),
    );
    // An action without a card is never shown.
    await expect(write("thread_mark_done@2", args)).rejects.toThrow(CardTargetMissingError);
  });
});
