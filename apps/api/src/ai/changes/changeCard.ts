// The Yes/No card of an AI change (VAY-2524), written by vayada from the stored change and what
// the person can see now, never by the model: what changes, on which records, and what else
// happens. The person's Yes binds to this text (its digest), so a card that would read differently
// now (a renamed room, a block that is gone) is never answered with an old Yes; nor is a change
// whose record moved past the version vayada read when the AI asked (proposeChange.ts).
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
  /** Other room types that share rooms with this one (linked inventory). */
  linkedRoomTypeIds(propertyId: string, roomTypeId: string): Promise<readonly string[]>;
  /** Null when the conversation is gone. */
  thread(propertyId: string, threadId: string): Promise<CardThread | null>;
  /** Null when the booking is gone. */
  booking(propertyId: string, guestBookingId: string): Promise<CardBooking | null>;
};
export type CardThread = {
  version: number;
  guestName: string | null;
  channel: "ota" | "email";
  providerChannel: string | null;
  lastMessageAt: string | null;
};
export type CardRoom = {
  roomId: string;
  roomTypeId: string;
  roomNumber: string;
  status: string;
  /** The room type's rooms revision, when the read gives it. */
  roomUnitsRevision: number | null;
};
export type CardRoomBlock = {
  version: string;
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
   * block released meanwhile, a version past the one vayada read when the AI asked) makes it
   * "changed". After the answer the card is only its title.
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
const LINKED = "Linked room types share these rooms, so their availability changes too.";
const LINKED_MAYBE = "If linked room types share these rooms, their availability changes too.";
const PROVIDERS: Readonly<Record<string, string>> = {
  airbnb: "Airbnb",
  booking: "Booking.com",
  booking_com: "Booking.com",
  "booking.com": "Booking.com",
  bookingcom: "Booking.com",
  expedia: "Expedia",
};

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

/** The first and last night and how many, however long the range. */
function nightSpan(startsOn: string, endsOn: string): { first: Date; last: Date; count: number } {
  const first = dayOf(startsOn);
  const last = dayOf(endsOn);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime()) || last < first) {
    throw new CardTargetMissingError();
  }
  return { first, last, count: Math.round((last.getTime() - first.getTime()) / DAY_MS) + 1 };
}

function dayText(day: Date, now: Date, withMonth: boolean): string {
  const base = `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()}`;
  if (!withMonth) return base;
  const year = day.getUTCFullYear() === now.getUTCFullYear() ? "" : ` ${day.getUTCFullYear()}`;
  return `${base} ${MONTHS[day.getUTCMonth()]}${year}`;
}

/** "Sat 12, Sun 13 and Mon 14 Dec"; more than a week: "Sat 12 Dec to Fri 1 Jan 2027". */
export function nightsText(startsOn: string, endsOn: string, now: Date): string {
  const { first, last, count } = nightSpan(startsOn, endsOn);
  if (count > 7) return `${dayText(first, now, true)} to ${dayText(last, now, true)}`;
  const nights = Array.from({ length: count }, (_, n) => new Date(first.getTime() + n * DAY_MS));
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

/**
 * The record moved past the version the change keeps (read when the AI asked): only while it
 * waits, since running it moves the record on.
 */
const movedSince = (input: CardInput, current: unknown, precondition: string) =>
  input.waiting && current !== input.arguments[precondition];

/** Ids as the database compares them: UUIDs in any case are one record. */
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A room type's name, by id in any case. */
async function typeNameOf(input: CardInput, roomTypeId: string): Promise<string> {
  for (const [id, name] of await input.reader.roomTypeNames(input.propertyId)) {
    if (sameId(id, roomTypeId)) return name;
  }
  throw new CardTargetMissingError();
}

/**
 * The rooms of one room type a change names, in the order asked and each once (proposeChange stores
 * ids in lower case, and the route blocks a room once however often it is named); any missing one
 * is a change.
 */
async function roomsOfType(
  input: CardInput,
  roomTypeId: string,
  roomIds: readonly string[],
): Promise<{ numbers: string[]; typeName: string; rooms: CardRoom[] }> {
  const [rooms, typeName] = await Promise.all([
    input.reader.rooms(input.propertyId),
    typeNameOf(input, roomTypeId),
  ]);
  const found: CardRoom[] = [];
  for (const roomId of roomIds) {
    const room = rooms.find((candidate) => sameId(candidate.roomId, roomId));
    if (!room || !sameId(room.roomTypeId, roomTypeId)) throw new CardTargetMissingError();
    if (!found.includes(room)) found.push(room);
  }
  if (found.length === 0) throw new CardTargetMissingError();
  return { numbers: found.map((room) => room.roomNumber), typeName, rooms: found };
}

const roomsText = (numbers: readonly string[]) =>
  numbers.length === 1 ? `room ${numbers[0]}` : `rooms ${listText(numbers)}`;

/**
 * Room types that share rooms with this one see the change too (linked inventory). Only a line of
 * what else happens: a person who can't read the groups, or a type whose name can't be read, gets
 * the same line without names, never a card they can't answer. A failed read still fails (it
 * would change the card's text between two looks).
 */
async function linkedEffect(input: CardInput, roomTypeId: string): Promise<string[]> {
  let linked: readonly string[];
  try {
    linked = await input.reader.linkedRoomTypeIds(input.propertyId, roomTypeId);
  } catch (error) {
    if (error instanceof CardReadError && error.reason === "not_allowed") return [LINKED_MAYBE];
    throw error;
  }
  if (linked.length === 0) return [];
  const names: string[] = [];
  for (const id of linked) {
    try {
      names.push(await typeNameOf(input, id));
    } catch (error) {
      if (!(error instanceof CardTargetMissingError)) throw error;
      return [LINKED];
    }
  }
  return [`${LINKED.slice(0, -1)}: ${listText(names)}.`];
}

const roomBlockCreate: CardWriter = async (input) => {
  const roomIds = Array.isArray(input.arguments.roomIds) ? input.arguments.roomIds.map(str) : [];
  const startsOn = str(input.arguments.startsOn);
  const endsOn = str(input.arguments.endsOn);
  const roomTypeId = str(input.arguments.roomTypeId);
  const { numbers, typeName } = await roomsOfType(input, roomTypeId, roomIds);
  const rooms = roomsText(numbers);
  const nights = plural(nightSpan(startsOn, endsOn).count, "night");
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
    effects: [
      `Guests can't book ${rooms} on these nights.`,
      ...(await linkedEffect(input, roomTypeId)),
      CHANNELS,
    ],
  };
};

const roomBlockRelease: CardWriter = async (input) => {
  const block = await input.reader.roomBlock(input.propertyId, str(input.arguments.blockId));
  // Released or expired meanwhile: there is nothing left to release; edited meanwhile: not the
  // block the AI asked about.
  if (!block || (input.waiting && block.status !== "active")) throw new CardTargetMissingError();
  if (movedSince(input, block.version, "expectedVersion")) throw new CardTargetMissingError();
  let rooms: string;
  let roomsValue: string;
  if (block.roomId) {
    const { numbers, typeName } = await roomsOfType(input, block.roomTypeId, [block.roomId]);
    rooms = roomsText(numbers);
    roomsValue = `${numbers[0]} · ${typeName}`;
  } else {
    rooms = `${plural(block.blockedCount, "room")} of ${await typeNameOf(input, block.roomTypeId)}`;
    roomsValue = rooms;
  }
  const nights = plural(nightSpan(block.startsOn, block.endsOn).count, "night");
  return {
    question: `Release the block on ${rooms} for ${nights}?`,
    doneTitle: `Released the block on ${rooms} for ${nights}`,
    yesLabel: "Yes, release the block",
    details: [
      { label: block.roomId ? "Room" : "Rooms", value: roomsValue },
      { label: "Nights", value: nightsText(block.startsOn, block.endsOn, input.now) },
    ],
    effects: [
      `Guests can book ${rooms} on these nights again.`,
      ...(await linkedEffect(input, block.roomTypeId)),
      CHANNELS,
    ],
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
  if (movedSince(input, rooms[0]!.roomUnitsRevision, "expectedRevision")) {
    throw new CardTargetMissingError();
  }
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
    if (!thread || movedSince(input, thread.version, "expectedThreadVersion")) {
      throw new CardTargetMissingError();
    }
    const who = thread.guestName
      ? `the conversation with ${thread.guestName}`
      : "a guest conversation";
    const { effect, details = [], ...text } = write(who, input);
    // Which conversation: a guest can write on two channels, and names can be missing.
    const channel =
      thread.channel === "email"
        ? "Email"
        : (PROVIDERS[thread.providerChannel?.trim().toLowerCase() ?? ""] ?? "Booking channel");
    return {
      ...text,
      details: [
        { label: "Guest", value: thread.guestName ?? "Name not known" },
        { label: "Channel", value: channel },
        ...(thread.lastMessageAt
          ? [{ label: "Last message", value: dateTimeText(thread.lastMessageAt, input.now) }]
          : []),
        ...details,
      ],
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
  const checkIn = dayOf(booking.checkIn);
  const nights = Math.round((dayOf(booking.checkOut).getTime() - checkIn.getTime()) / DAY_MS);
  if (Number.isNaN(nights)) throw new CardTargetMissingError();
  const stay = `${nights >= 1 ? `${plural(nights, "night")} from` : "from"} ${dayText(checkIn, input.now, true)}`;
  return {
    question: `Add a private note to ${whose}?`,
    doneTitle: `Added a private note to ${whose}`,
    yesLabel: "Yes, add the note",
    details: [
      {
        label: "Booking",
        value: `${booking.reference} · ${stay}`,
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
 * What a card could never show, checked when the AI asks (proposeChange), so it is refused as
 * invalid input instead of later as "changed". Paths only, never values.
 */
export function changeArgumentProblem(
  actionKey: string,
  args: Readonly<Record<string, unknown>>,
): string | null {
  if (actionKey === "room_block_create@1" && str(args.endsOn) < str(args.startsOn)) {
    return "endsOn: must not be before startsOn";
  }
  return null;
}

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
