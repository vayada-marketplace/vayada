import type { Booking } from "@/services/bookings";
import type { CalendarData } from "@/services/calendar";
import type { RegistrationGuest } from "./registration";

const DAY_MS = 86_400_000;

export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.max(0, Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / DAY_MS));
}

function overlaps(fromA: string, toA: string, fromB: string, toB: string): boolean {
  return fromA < toB && fromB < toA;
}

/** One booked room as the check-in shows it (VAY-2373). */
export interface CheckinRoom {
  /** The assignment id, or `position-N` for a room without one. */
  key: string;
  assignmentId: string | null;
  position: number;
  roomId: string | null;
  /** The room number; null while no room is assigned. */
  unit: string | null;
  roomTypeId: string | null;
  /** The room type's name. */
  type: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  /** Adults and children booked into this room; null when unknown. */
  guests: number | null;
  /** Leaves before the booking's last room does. */
  departsEarlier: boolean;
  /** The average recorded price a night, when every night has one. */
  nightlyRate: number | null;
  /** The rate plan the room was booked on, when named. */
  ratePlan: string | null;
  currency: string | null;
}

/** The booking's rooms in booking order, each with its own dates (multi-room bookings can differ). */
export function checkinRooms(booking: Booking): CheckinRoom[] {
  const stays = [...booking.stays].sort((a, b) => a.position - b.position);
  const rooms = stays.length
    ? stays.map((stay, index) => {
        const assigned = booking.assignedRooms?.find((room) => room.position === stay.position);
        const priced = stay.nightly.filter((night) => night.appliedAmount != null);
        return {
          key: assigned?.assignmentId ?? `position-${stay.position}`,
          assignmentId: assigned?.assignmentId ?? null,
          position: stay.position,
          roomId: assigned?.roomId ?? (index === 0 ? booking.roomId : null),
          unit:
            stay.roomNumber ?? assigned?.roomNumber ?? (index === 0 ? booking.roomNumber : null),
          roomTypeId: assigned?.roomTypeId ?? (index === 0 ? booking.roomTypeId : null),
          type: stay.roomName,
          checkIn: stay.checkIn ?? booking.checkIn,
          checkOut: stay.checkOut ?? booking.checkOut,
          guests: stay.adults == null ? null : stay.adults + (stay.children ?? 0),
          nightlyRate:
            priced.length && priced.length === stay.nightly.length
              ? priced.reduce((sum, night) => sum + (night.appliedAmount ?? 0), 0) / priced.length
              : null,
          currency: priced[0]?.currency ?? null,
          ratePlan: stay.ratePlanName,
        };
      })
    : [
        {
          key: booking.assignedRooms?.[0]?.assignmentId ?? "position-0",
          assignmentId: booking.assignedRooms?.[0]?.assignmentId ?? null,
          position: 0,
          roomId: booking.roomId,
          unit: booking.roomNumber,
          roomTypeId: booking.roomTypeId,
          type: booking.roomName,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          guests: booking.adults + booking.children,
          nightlyRate: null,
          currency: null,
          ratePlan: null,
        },
      ];
  const lastCheckOut = rooms.reduce(
    (last, room) => (room.checkOut > last ? room.checkOut : last),
    "",
  );
  return rooms.map((room) => ({
    ...room,
    nights: nightsBetween(room.checkIn, room.checkOut),
    departsEarlier: room.checkOut < lastCheckOut,
  }));
}

/** Who sleeps in which room: the room saved on a guest's registration, else the next room with a
 * free bed, in booking order; a guest beyond every room's beds goes to the last room. */
export function guestsByRoom(
  guests: RegistrationGuest[],
  rooms: CheckinRoom[],
): Map<string, RegistrationGuest[]> {
  const placed = new Map(rooms.map((room) => [room.key, [] as RegistrationGuest[]]));
  if (!rooms.length) return placed;
  const unplaced: RegistrationGuest[] = [];
  for (const guest of guests) {
    const saved = guest.registration?.assignmentId;
    const room = saved ? rooms.find((entry) => entry.assignmentId === saved) : undefined;
    if (room) placed.get(room.key)!.push(guest);
    else unplaced.push(guest);
  }
  for (const guest of unplaced) {
    const room =
      rooms.find((entry) => placed.get(entry.key)!.length < (entry.guests ?? Infinity)) ??
      rooms[rooms.length - 1]!;
    placed.get(room.key)!.push(guest);
  }
  // Keep each room's guests in form order.
  for (const room of rooms)
    placed.set(
      room.key,
      placed.get(room.key)!.sort((a, b) => guests.indexOf(a) - guests.indexOf(b)),
    );
  return placed;
}

export type RoomOptionState =
  | "current"
  | "free"
  | "occupied"
  | "blocked"
  | "out_of_service"
  | "in_booking";

export interface RoomOption {
  roomId: string;
  roomNumber: string;
  state: RoomOptionState;
  /** Occupied or blocked: the first clash's dates (check-out / block end exclusive). */
  from?: string;
  to?: string;
}

/** Every room the move picker lists for one booked room, grouped by room type with the booked type
 * first: free rooms of any type can be picked (D7); the rest say why not. The server re-checks. */
export function roomMoveOptions(
  room: CheckinRoom,
  booking: Booking,
  calendar: Pick<CalendarData, "rooms" | "bookings" | "blocks">,
): Array<{ roomTypeId: string; roomTypeName: string; options: RoomOption[] }> {
  const ownRoomIds = new Set(
    (booking.assignedRooms ?? []).map((assigned) => assigned.roomId).filter(Boolean),
  );
  const groups = new Map<
    string,
    { roomTypeId: string; roomTypeName: string; options: RoomOption[] }
  >();
  const sorted = [...calendar.rooms].sort(
    (a, b) =>
      Number(b.roomTypeId === room.roomTypeId) - Number(a.roomTypeId === room.roomTypeId) ||
      a.roomTypeName.localeCompare(b.roomTypeName) ||
      a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }),
  );
  for (const candidate of sorted) {
    const clash = calendar.bookings.find(
      (other) =>
        other.roomId === candidate.id &&
        other.id !== booking.id &&
        overlaps(room.checkIn, room.checkOut, other.checkIn, other.checkOut),
    );
    const block = calendar.blocks.find(
      (entry) =>
        entry.roomId === candidate.id &&
        overlaps(room.checkIn, room.checkOut, entry.startDate, entry.endDate),
    );
    const option: RoomOption =
      candidate.id === room.roomId
        ? { roomId: candidate.id, roomNumber: candidate.roomNumber, state: "current" }
        : ownRoomIds.has(candidate.id)
          ? { roomId: candidate.id, roomNumber: candidate.roomNumber, state: "in_booking" }
          : candidate.status !== "available"
            ? { roomId: candidate.id, roomNumber: candidate.roomNumber, state: "out_of_service" }
            : clash
              ? {
                  roomId: candidate.id,
                  roomNumber: candidate.roomNumber,
                  state: "occupied",
                  from: clash.checkIn,
                  to: clash.checkOut,
                }
              : block
                ? {
                    roomId: candidate.id,
                    roomNumber: candidate.roomNumber,
                    state: "blocked",
                    from: block.startDate,
                    to: block.endDate,
                  }
                : { roomId: candidate.id, roomNumber: candidate.roomNumber, state: "free" };
    const group = groups.get(candidate.roomTypeId) ?? {
      roomTypeId: candidate.roomTypeId,
      roomTypeName: candidate.roomTypeName,
      options: [],
    };
    group.options.push(option);
    groups.set(candidate.roomTypeId, group);
  }
  return Array.from(groups.values());
}
