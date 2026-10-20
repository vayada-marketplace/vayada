import { CheckIcon } from "@heroicons/react/24/outline";

export type QuickPreviewRoom = Readonly<{ name: string; details: string; price: string }>;

export type QuickBookingPagePreviewProps = {
  /** Shown in the browser bar, e.g. "hotel-alpenrose.booking.vayada.com". */
  url: string;
  hotelName: string;
  /** Street and city under the name. */
  place: string;
  /** The rooms guests choose from; none yet → a faded "Your first room" placeholder. */
  rooms: readonly QuickPreviewRoom[];
  /** For the placeholder room's price ("€ —"). */
  currencySymbol?: string;
  /** After publishing: a green "Live" pill under the name. */
  live?: boolean;
  /** For the sample dates (a weekend two weeks out); tests pass a fixed day. */
  today?: Date;
};

const GRADIENT = "bg-gradient-to-b from-[#8FA3BC] to-[#4B5B73]";

/** A Friday about two weeks out and the Sunday after, as "Fri 6 Nov". */
export function sampleStay(today: Date): { checkIn: string; checkOut: string } {
  const start = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + 14));
  start.setUTCDate(start.getUTCDate() + ((5 - start.getUTCDay() + 7) % 7));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 2);
  const format = (date: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    })
      .format(date)
      .replace(",", "");
  return { checkIn: format(start), checkOut: format(end) };
}

/**
 * VAY-2247 booking-page preview (Paper rev 3/4): a browser frame with the hotel's hero (the no-photo
 * gradient guests see until photos are added), sample dates and the rooms with their price.
 */
export function QuickBookingPagePreview({
  url,
  hotelName,
  place,
  rooms,
  currencySymbol = "",
  live = false,
  today = new Date(),
}: QuickBookingPagePreviewProps) {
  const stay = sampleStay(today);
  const shown = rooms.length
    ? rooms.map((room) => ({ ...room, ghost: false }))
    : [
        {
          name: "Your first room",
          details: "Name, guests and price appear here",
          price: `${currencySymbol} —`.trim(),
          ghost: true,
        },
      ];

  return (
    <div
      aria-hidden="true"
      className="w-full overflow-hidden rounded-[18px] bg-white shadow-[0_30px_60px_rgba(30,62,219,0.18),0_8px_20px_rgba(17,24,39,0.08)]"
    >
      <div className="flex items-center gap-[5px] border-b border-gray-200 px-[13px] py-[11px]">
        {[0, 1, 2].map((dot) => (
          <span key={dot} className="h-[9px] w-[9px] shrink-0 rounded-full bg-gray-300" />
        ))}
        <span className="ml-2 flex h-[26px] min-w-0 flex-1 items-center justify-center truncate rounded-[7px] bg-gray-100 px-2 text-xs text-gray-500">
          {url}
        </span>
      </div>
      <div
        className={`flex h-[220px] flex-col justify-end gap-0.5 p-[22px] text-white ${GRADIENT}`}
      >
        <p className="truncate text-[26px] font-bold leading-tight">{hotelName || "Your hotel"}</p>
        {place ? <p className="truncate text-sm opacity-90">{place}</p> : null}
        {live ? (
          <span className="mt-2.5 inline-flex w-fit items-center gap-1 rounded-full bg-green-600 px-2.5 py-1 text-xs font-semibold">
            <CheckIcon className="h-3.5 w-3.5" />
            Live
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-3 p-4">
        <div className="grid grid-cols-3 gap-3 rounded-xl border border-gray-200 px-3.5 py-3">
          {[
            ["Check-in", stay.checkIn],
            ["Check-out", stay.checkOut],
            ["Guests", "2 adults"],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0">
              <p className="text-[11px] font-semibold text-gray-500">{label}</p>
              <p className="mt-0.5 truncate text-sm font-semibold text-gray-900">{value}</p>
            </div>
          ))}
        </div>
        <p className="mt-1 text-[15px] font-semibold text-gray-900">Choose your room</p>
        {shown.map((room, index) => (
          <div
            key={`${room.name}-${index}`}
            className={`flex items-center gap-3 rounded-xl border border-gray-200 p-2.5 ${
              room.ghost ? "opacity-[0.45]" : ""
            }`}
          >
            <span className={`h-16 w-[84px] shrink-0 rounded-lg ${GRADIENT}`} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-gray-900">{room.name}</p>
              <p className="mt-0.5 text-xs leading-4 text-gray-500">{room.details}</p>
              <p className="mt-1.5 text-sm font-bold text-gray-900">
                {room.price}
                <span className="ml-1 text-xs font-normal text-gray-500">/ night</span>
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-gray-900 px-3 py-[7px] text-xs font-semibold text-white">
              Book
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
