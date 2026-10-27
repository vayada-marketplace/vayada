type Translate = (key: string, params?: Record<string, string | number>) => string;

/** "1 night" / "3 nights", from the `dashboard.popup.…One` / `…Many` pairs (VAY-2372). */
export function countLabel(
  t: Translate,
  key: "nights" | "adults" | "children" | "rooms" | "guests",
  count: number,
): string {
  return t(`dashboard.popup.${key}${count === 1 ? "One" : "Many"}`, { count });
}

/** "Aug 15 – 17", in the reader's language; property dates, so read as UTC. */
export function stayRangeLabel(locale: string, checkIn: string, checkOut: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).formatRange(new Date(`${checkIn}T00:00:00Z`), new Date(`${checkOut}T00:00:00Z`));
}

/** "Grace Hopper", or "Guest 3" for a guest nobody has named yet. */
export function guestDisplayName(
  guest: { firstName: string; lastName: string },
  number: number,
  t: Translate,
): string {
  return (
    `${guest.firstName} ${guest.lastName}`.trim() || t("dashboard.popup.guestNumber", { number })
  );
}

/** The guest's expected arrival time; the dashboard's 3:00 PM when the booking names none. */
export function bookingArrivalTime(booking: { estimatedArrivalTime: string | null }): string {
  return booking.estimatedArrivalTime || "3:00 PM";
}
