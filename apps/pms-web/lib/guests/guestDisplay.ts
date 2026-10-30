/** VAY-2420: how search, the Guests list and the guest profile show a guest and their stays. */

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function guestInitials(firstName: string, lastName: string): string {
  return `${firstName.trim().charAt(0)}${lastName.trim().charAt(0)}`.toUpperCase() || "?";
}

/** Today on this device as YYYY-MM-DD. */
export function localToday(now = new Date()): string {
  return now.toLocaleDateString("en-CA");
}

const day = (date: string) => new Date(`${date}T00:00:00Z`);

export function formatGuestDate(date: string, locale: string, withYear = true): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(day(date));
}

/** "Oct 29 – Nov 1, 2026": the year once, at the end, when both dates share it. */
export function formatStayDates(checkIn: string, checkOut: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).formatRange(day(checkIn), day(checkOut));
}

export function stayNights(checkIn: string, checkOut: string): number {
  return Math.round((day(checkOut).getTime() - day(checkIn).getTime()) / 86_400_000);
}

/** The guest's arrival status in search and the Guests list ("Arriving today", "Last stay …"). */
export function guestActivity(
  lastCheckIn: string | null,
  today: string,
  locale: string,
  t: Translate,
): string | null {
  if (!lastCheckIn) return null;
  if (lastCheckIn === today) return t("guests.arrivingToday");
  if (lastCheckIn > today)
    return t("guests.arrivingOn", { date: formatGuestDate(lastCheckIn, locale, false) });
  return t("guests.lastStay", { date: formatGuestDate(lastCheckIn, locale) });
}

// The booking's lifecycle status (booking.guest_bookings) → label and pill colours.
const STAY_STATUS: Record<string, { labelKey: string; className: string }> = {
  draft: { labelKey: "bookings.statusPending", className: "bg-yellow-50 text-yellow-700" },
  pending_payment: {
    labelKey: "bookings.statusAwaitingPayment",
    className: "bg-yellow-50 text-yellow-700",
  },
  confirmed: { labelKey: "bookings.statusConfirmed", className: "bg-[#EAF7EE] text-[#166534]" },
  completed: { labelKey: "bookings.statusCompleted", className: "bg-blue-50 text-blue-700" },
  canceled: { labelKey: "bookings.statusCancelled", className: "bg-red-50 text-red-700" },
  declined: { labelKey: "bookings.statusDeclined", className: "bg-rose-50 text-rose-700" },
  expired: { labelKey: "bookings.statusExpired", className: "bg-gray-100 text-gray-600" },
  no_show: { labelKey: "bookings.statusNoShow", className: "bg-orange-50 text-orange-700" },
};

export function stayStatus(status: string): { labelKey: string | null; className: string } {
  return STAY_STATUS[status] ?? { labelKey: null, className: "bg-gray-100 text-gray-600" };
}

const PROPERTY_COLORS = ["#F59E0B", "#0E7490", "#7C3AED", "#DB2777", "#16A34A", "#2563EB"];

/** A steady tile colour per property, so a guest's stays at one hotel look alike. */
export function propertyColor(propertyId: string): string {
  let hash = 0;
  for (const char of propertyId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PROPERTY_COLORS[hash % PROPERTY_COLORS.length]!;
}

export function stayRoleKey(role: "booker" | "primary_guest" | "additional_guest"): string {
  return role === "additional_guest" ? "guests.roleAdditional" : "guests.roleLead";
}
