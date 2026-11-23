// The Yes/No card of an AI change (VAY-2524), written by vayada from the stored change and what
// the person can see now, never by the model: what changes, on which records, and what else
// happens. The person's Yes binds to this text (its digest), so a card that would read differently
// now (a renamed room, a block that is gone) is never answered with an old Yes.
import { createHash } from "node:crypto";

import { canonicalJson } from "../executor/operationStore.js";

export type ChangeCard = {
  /** "Block room 12 for 3 nights?" */
  question: string;
  /** "Blocked room 12 for 3 nights": the card's title once it ran. */
  doneTitle: string;
  /** "Yes, block room 12" */
  yesLabel: string;
  details: readonly { label: string; value: string }[];
  /** What else happens, outside the record itself. */
  effects: readonly string[];
};

/** The records a card names, read as the person who answers (their own rights). */
export type CardReader = {
  rooms(propertyId: string): Promise<readonly CardRoom[]>;
  roomTypeNames(propertyId: string): Promise<ReadonlyMap<string, string>>;
  /** Null when the block is gone. */
  roomBlock(propertyId: string, blockId: string): Promise<CardRoomBlock | null>;
  /** Null when the conversation is gone. */
  thread(propertyId: string, threadId: string): Promise<{ guestName: string | null } | null>;
  /** Null when the booking is gone. */
  booking(propertyId: string, guestBookingId: string): Promise<CardBooking | null>;
};
export type CardRoom = { roomId: string; roomTypeId: string; roomNumber: string; status: string };
export type CardRoomBlock = {
  roomTypeId: string;
  roomId: string | null;
  startsOn: string;
  endsOn: string;
  blockedCount: number;
  status: string;
};
export type CardBooking = {
  guestName: string;
  reference: string;
  checkIn: string;
  checkOut: string;
};

/** A record the change names is gone, or no longer what the change was asked for. */
export class CardTargetMissingError extends Error {
  constructor() {
    super("A record this change names is gone");
    this.name = "CardTargetMissingError";
  }
}

/** The person can't read a record the card names, or the read failed. */
export class CardReadError extends Error {
  constructor(readonly reason: "not_allowed" | "unavailable") {
    super(`The card's records could not be read (${reason})`);
    this.name = "CardReadError";
  }
}

type CardInput = {
  propertyId: string;
  arguments: Record<string, unknown>;
  reader: CardReader;
  /** For the year: shown only when it is not this year. */
  now: Date;
  /**
   * The change still waits for its answer: a record that no longer is what it was asked for (a
   * block released meanwhile) makes it "changed". After the answer the card is only its title.
   */
  waiting: boolean;
};
type CardWriter = (input: CardInput) => Promise<ChangeCard>;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;
const ROOM_STATES: Readonly<Record<string, string>> = {
  available: "available",
  maintenance: "maintenance",
  out_of_order: "out of order",
  retired: "retired",
};
const CHANNELS = "If channels are connected, they get the new availability.";
const GUEST_NOT_TOLD = "The guest is not told.";

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const dayOf = (date: string) => new Date(`${date}T00:00:00Z`);
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** "a", "a and b", "a, b and c"; past `max` items, "and 3 more". */
export function listText(items: readonly string[], max = 5): string {
  const shown =
    items.length > max ? [...items.slice(0, max - 1), `${items.length - max + 1} more`] : items;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

function nightsOf(startsOn: string, endsOn: string): Date[] {
  const start = dayOf(startsOn).getTime();
  const end = dayOf(endsOn).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new CardTargetMissingError();
  }
  const nights: Date[] = [];
  for (let at = start; at <= end && nights.length <= 366; at += DAY_MS) nights.push(new Date(at));
  return nights;
}

function dayText(day: Date, now: Date, withMonth: boolean): string {
  const base = `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()}`;
  if (!withMonth) return base;
  const year = day.getUTCFullYear() === now.getUTCFullYear() ? "" : ` ${day.getUTCFullYear()}`;
  return `${base} ${MONTHS[day.getUTCMonth()]}${year}`;
}

/** "Sat 12, Sun 13 and Mon 14 Dec"; more than a week: "Sat 12 Dec to Fri 1 Jan 2027". */
export function nightsText(startsOn: string, endsOn: string, now: Date): string {
  const nights = nightsOf(startsOn, endsOn);
  if (nights.length > 7) {
    return `${dayText(nights[0]!, now, true)} to ${dayText(nights[nights.length - 1]!, now, true)}`;
  }
  // The month (and year) after the last night of each month.
  return listText(
    nights.map((night, index) => {
      const next = nights[index + 1];
      return dayText(night, now, !next || next.getUTCMonth() !== night.getUTCMonth());
    }),
    7,
  );
}

/** "Mon 14 Dec, 09:00 UTC" */
export function dateTimeText(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) throw new CardTargetMissingError();
  const time = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
  return `${dayText(at, now, true)}, ${time} UTC`;
}

/** The rooms of one room type a change names, in the order asked; any missing one is a change. */
async function roomsOfType(
  input: CardInput,
  roomTypeId: string,
  roomIds: readonly string[],
): Promise<{ numbers: string[]; typeName: string; rooms: CardRoom[] }> {
  const [rooms, typeNames] = await Promise.all([
    input.reader.rooms(input.propertyId),
    input.reader.roomTypeNames(input.propertyId),
  ]);
  const typeName = typeNames.get(roomTypeId);
  if (!typeName) throw new CardTargetMissingError();
  const found = roomIds.map((roomId) => {
    const room = rooms.find((candidate) => candidate.roomId === roomId);
    if (!room || room.roomTypeId !== roomTypeId) throw new CardTargetMissingError();
    return room;
  });
  return { numbers: found.map((room) => room.roomNumber), typeName, rooms: found };
}

const roomsText = (numbers: readonly string[]) =>
  numbers.length === 1 ? `room ${numbers[0]}` : `rooms ${listText(numbers)}`;

const roomBlockCreate: CardWriter = async (input) => {
  const roomIds = Array.isArray(input.arguments.roomIds) ? input.arguments.roomIds.map(str) : [];
  const startsOn = str(input.arguments.startsOn);
  const endsOn = str(input.arguments.endsOn);
  const { numbers, typeName } = await roomsOfType(input, str(input.arguments.roomTypeId), roomIds);
  const rooms = roomsText(numbers);
  const nights = plural(nightsOf(startsOn, endsOn).length, "night");
  const reason = str(input.arguments.reason).trim();
  return {
    question: `Block ${rooms} for ${nights}?`,
    doneTitle: `Blocked ${rooms} for ${nights}`,
    yesLabel: numbers.length === 1 ? `Yes, block ${rooms}` : `Yes, block ${numbers.length} rooms`,
    details: [
      {
        label: numbers.length === 1 ? "Room" : "Rooms",
        value: `${listText(numbers)} · ${typeName}`,
      },
      { label: "Nights", value: nightsText(startsOn, endsOn, input.now) },
      ...(reason ? [{ label: "Reason", value: reason }] : []),
    ],
    effects: [`Guests can't book ${rooms} on these nights.`, CHANNELS],
  };
};

const roomBlockRelease: CardWriter = async (input) => {
  const block = await input.reader.roomBlock(input.propertyId, str(input.arguments.blockId));
  // Released or expired meanwhile: there is nothing left to release.
  if (!block || (input.waiting && block.status !== "active")) throw new CardTargetMissingError();
  let rooms: string;
  let roomsValue: string;
  if (block.roomId) {
    const { numbers, typeName } = await roomsOfType(input, block.roomTypeId, [block.roomId]);
    rooms = roomsText(numbers);
    roomsValue = `${numbers[0]} · ${typeName}`;
  } else {
    const typeName = (await input.reader.roomTypeNames(input.propertyId)).get(block.roomTypeId);
    if (!typeName) throw new CardTargetMissingError();
    rooms = `${plural(block.blockedCount, "room")} of ${typeName}`;
    roomsValue = rooms;
  }
  const nights = plural(nightsOf(block.startsOn, block.endsOn).length, "night");
  return {
    question: `Release the block on ${rooms} for ${nights}?`,
    doneTitle: `Released the block on ${rooms} for ${nights}`,
    yesLabel: "Yes, release the block",
    details: [
      { label: block.roomId ? "Room" : "Rooms", value: roomsValue },
      { label: "Nights", value: nightsText(block.startsOn, block.endsOn, input.now) },
    ],
    effects: [`Guests can book ${rooms} on these nights again.`, CHANNELS],
  };
};

const roomStatusSet: CardWriter = async (input) => {
  const { numbers, typeName, rooms } = await roomsOfType(input, str(input.arguments.roomTypeId), [
    str(input.arguments.roomUnitId),
  ]);
  const changes = (input.arguments.changes ?? {}) as { status?: unknown };
  const target = ROOM_STATES[str(changes.status)];
  const current = ROOM_STATES[rooms[0]!.status] ?? rooms[0]!.status;
  if (!target) throw new CardTargetMissingError();
  const room = `room ${numbers[0]}`;
  return {
    question: `Set ${room} to ${target}?`,
    doneTitle: `Set ${room} to ${target}`,
    yesLabel: `Yes, set it to ${target}`,
    details: [
      { label: "Room", value: `${numbers[0]} · ${typeName}` },
      { label: "Now", value: current },
      { label: "New", value: target },
    ],
    effects: [
      target === "available"
        ? `Guests can be given ${room} again.`
        : `Guests can't be given ${room} while it is ${target}.`,
      "Bookings and prices don't change.",
    ],
  };
};

/** The three ways of sorting a guest conversation. */
function threadWriter(
  write: (
    who: string,
    input: CardInput,
  ) => Omit<ChangeCard, "details" | "effects"> & {
    details?: ChangeCard["details"];
    effect: string;
  },
): CardWriter {
  return async (input) => {
    const thread = await input.reader.thread(input.propertyId, str(input.arguments.threadId));
    if (!thread) throw new CardTargetMissingError();
    const who = thread.guestName
      ? `the conversation with ${thread.guestName}`
      : "a guest conversation";
    const { effect, details = [], ...text } = write(who, input);
    return {
      ...text,
      details: [{ label: "Guest", value: thread.guestName ?? "Name not known" }, ...details],
      effects: [effect, GUEST_NOT_TOLD],
    };
  };
}

const threadMarkDone = threadWriter((who) => ({
  question: `Mark ${who} as done?`,
  doneTitle: `Marked ${who} as done`,
  yesLabel: "Yes, mark it done",
  effect: "It leaves the list of conversations that need an answer.",
}));

const threadFollowUp = threadWriter((who, input) => {
  const until = dateTimeText(str(input.arguments.followUpAt), input.now);
  return {
    question: `Set ${who} aside until ${until}?`,
    doneTitle: `Set ${who} aside until ${until}`,
    yesLabel: "Yes, set it aside",
    details: [{ label: "Until", value: until }],
    effect: "Then it is back in the list of conversations that need an answer.",
  };
});

const threadReopen = threadWriter((who) => ({
  question: `Open ${who} again?`,
  doneTitle: `Opened ${who} again`,
  yesLabel: "Yes, open it again",
  effect: "It is back in the list of conversations that need an answer.",
}));

const bookingNoteAdd: CardWriter = async (input) => {
  const booking = await input.reader.booking(input.propertyId, str(input.arguments.guestBookingId));
  if (!booking) throw new CardTargetMissingError();
  const whose = booking.guestName.trim()
    ? `${booking.guestName.trim()}'s booking`
    : `booking ${booking.reference}`;
  const lastNight = new Date(dayOf(booking.checkOut).getTime() - DAY_MS).toISOString().slice(0, 10);
  return {
    question: `Add a private note to ${whose}?`,
    doneTitle: `Added a private note to ${whose}`,
    yesLabel: "Yes, add the note",
    details: [
      {
        label: "Booking",
        value: `${booking.reference} · ${plural(nightsOf(booking.checkIn, lastNight).length, "night")} from ${dayText(dayOf(booking.checkIn), input.now, true)}`,
      },
      { label: "Note", value: str(input.arguments.body).trim() },
    ],
    effects: ["Only your team sees the note; the guest never does."],
  };
};

/** One writer per change action (name@version); a change without one is never asked. */
export const CARD_WRITERS: Readonly<Record<string, CardWriter>> = {
  "room_block_create@1": roomBlockCreate,
  "room_block_release@1": roomBlockRelease,
  "room_status_set@1": roomStatusSet,
  "thread_mark_done@1": threadMarkDone,
  "thread_follow_up@1": threadFollowUp,
  "thread_reopen@1": threadReopen,
  "booking_note_add@1": bookingNoteAdd,
};

/**
 * The card of a change as it reads now. Throws CardTargetMissingError when a record it names is
 * gone, CardReadError when the person can't read one (or the read failed).
 */
export async function writeChangeCard(actionKey: string, input: CardInput): Promise<ChangeCard> {
  const writer = Object.hasOwn(CARD_WRITERS, actionKey) ? CARD_WRITERS[actionKey] : undefined;
  if (!writer) throw new CardTargetMissingError();
  return writer(input);
}

/** What the person's Yes binds to: this operation, its route preview and the card's text. */
export function cardSha256(
  operation: { id: string; previewSha256: string | null },
  card: ChangeCard,
): string {
  return createHash("sha256")
    .update(canonicalJson({ id: operation.id, preview: operation.previewSha256, card }))
    .digest("hex");
}
