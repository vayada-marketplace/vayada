"use client";

/** One booked room on the Extras step: "ROOM 1 · 2 ADULTS", its place, rate and nights, price. */
export type ExtrasRoomLine = {
  selectionId: string;
  title: string;
  name: string;
  rate: string;
  /** The room's price in this quote, or null while it is being priced. */
  price: string | null;
};

/**
 * VAY-2393: the rooms part of Timo's "Your booking" panel on the Extras step: each room with
 * Change (back to the room cards with that room open) and, with two or more rooms, Remove. The
 * total and Continue stay in the Extras bar (VAY-2391), so they never show twice.
 */
export default function ExtrasRooms({
  rooms,
  onChange,
  onRemove,
  labels,
}: {
  rooms: ExtrasRoomLine[];
  onChange: (index: number) => void;
  /** Null with one room: a booking keeps at least one. `byKeyboard` moves focus to Undo. */
  onRemove: ((index: number, byKeyboard: boolean) => void) | null;
  labels: {
    title: string;
    change: string;
    changeRoom: (number: number) => string;
    remove: string;
    removeRoom: (number: number) => string;
  };
}) {
  return (
    <section
      aria-labelledby="extras-rooms-title"
      data-testid="extras-rooms"
      className="rounded-2xl border border-gray-200 bg-white p-5"
    >
      {/* Focused after a room is removed or brought back, as its own button is gone. */}
      <h2
        id="extras-rooms-title"
        tabIndex={-1}
        className="text-base font-bold text-gray-900 outline-none"
      >
        {labels.title}
      </h2>
      <ul className="mt-3 divide-y divide-gray-100">
        {rooms.map((room, index) => (
          <li
            key={room.selectionId}
            data-testid={`extras-room-${index + 1}`}
            className="flex justify-between gap-3 py-3"
          >
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-wide text-gray-600">
                {room.title}
              </p>
              <p className="font-semibold text-gray-900">{room.name}</p>
              <p className="text-sm text-gray-500">{room.rate}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <p className="font-semibold text-gray-900">{room.price ?? "—"}</p>
              <div className="flex gap-3">
                <button
                  type="button"
                  aria-label={labels.changeRoom(index + 1)}
                  onClick={() => onChange(index)}
                  className="min-h-[36px] text-sm font-semibold text-gray-900 underline underline-offset-2"
                >
                  {labels.change}
                </button>
                {onRemove && (
                  <button
                    type="button"
                    aria-label={labels.removeRoom(index + 1)}
                    onClick={(event) => onRemove(index, event.detail === 0)}
                    className="min-h-[36px] text-sm font-semibold text-red-700 underline underline-offset-2"
                  >
                    {labels.remove}
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
