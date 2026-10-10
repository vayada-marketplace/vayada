import type { RoomSelection } from "@/lib/types";

/** Compare all rate keys and allocations, never just the first room type. */
export function sameRoomSelection(left?: RoomSelection, right?: RoomSelection): boolean {
  return Boolean(
    left &&
      right &&
      left.contractVersion === right.contractVersion &&
      Array.isArray(left.lines) &&
      Array.isArray(right.lines) &&
      left.lines.length === right.lines.length &&
      left.lines.every((line, index) => {
        const other = right.lines[index];
        return (
          other &&
          line.roomTypeId === other.roomTypeId &&
          line.publicOfferKey === other.publicOfferKey &&
          Array.isArray(line.guests) &&
          Array.isArray(other.guests) &&
          line.guests.length === other.guests.length &&
          line.guests.every(
            (guest, position) =>
              guest.adults === other.guests[position]?.adults &&
              guest.children === other.guests[position]?.children,
          )
        );
      }),
  );
}
export function roomSelectionPartyMatches(
  selection: RoomSelection,
  adults: number,
  children: number,
): boolean {
  const guests = selection.lines.flatMap((line) => line.guests);
  return (
    guests.reduce((sum, guest) => sum + guest.adults, 0) === adults &&
    guests.reduce((sum, guest) => sum + guest.children, 0) === children
  );
}
