// Rooms & Rates renders the API's room types in order, then filters the API's
// rooms for each type. Preserve both canonical sequences in flat calendar views.
export function orderRoomsByRoomType<T extends { roomTypeId: string }>(
  rooms: readonly T[],
  roomTypeIds: readonly string[],
): T[] {
  const positions = new Map(roomTypeIds.map((id, index) => [id, index]));
  return [...rooms].sort(
    (a, b) =>
      (positions.get(a.roomTypeId) ?? roomTypeIds.length) -
      (positions.get(b.roomTypeId) ?? roomTypeIds.length),
  );
}

export type RoomTypeGroup<T> = { roomTypeId: string; rooms: T[] };

// Rooms grouped by room type, in the order each type first appears.
export function groupRoomsByType<T extends { roomTypeId: string }>(
  rooms: readonly T[],
): RoomTypeGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const room of rooms) {
    groups.set(room.roomTypeId, [...(groups.get(room.roomTypeId) ?? []), room]);
  }
  return Array.from(groups, ([roomTypeId, grouped]) => ({ roomTypeId, rooms: grouped }));
}

// Calendar reorder mode (VAY-2294): a room type moves past its neighbouring type
// with all its rooms; the server then saves that type order too.
export function moveRoomType<T extends { roomTypeId: string }>(
  rooms: readonly T[],
  roomTypeId: string,
  direction: -1 | 1,
): T[] {
  const groups = groupRoomsByType(rooms);
  const index = groups.findIndex((group) => group.roomTypeId === roomTypeId);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= groups.length) return [...rooms];
  [groups[index], groups[next]] = [groups[next]!, groups[index]!];
  return groups.flatMap((group) => group.rooms);
}

// A room only swaps with its neighbour of the same room type.
export function moveRoomWithinType<T extends { id: string; roomTypeId: string }>(
  rooms: readonly T[],
  roomId: string,
  direction: -1 | 1,
): T[] {
  const moved = [...rooms];
  const index = moved.findIndex((room) => room.id === roomId);
  const next = index + direction;
  if (index < 0 || moved[next]?.roomTypeId !== moved[index]!.roomTypeId) return moved;
  [moved[index], moved[next]] = [moved[next]!, moved[index]!];
  return moved;
}
