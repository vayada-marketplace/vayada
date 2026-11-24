import { Booking } from "@/services/bookings";

const DASHBOARD_BOOKING_STATUSES = new Set<Booking["status"]>([
  "confirmed",
  "checked_in",
  "in_house",
  "checked_out",
]);

const NOT_CHECKED_IN_DEPARTURE_STATUSES = new Set<Booking["status"]>(["confirmed"]);

const CHECKED_IN_STATUSES = new Set<Booking["status"]>(["checked_in", "in_house", "checked_out"]);
const CHECKED_OUT_STATUSES = new Set<Booking["status"]>(["checked_out"]);

export type DashboardInventoryDay = {
  stayDate: string;
  totalCount: number;
  blockedCount: number;
  occupiedCount: number;
};

export function getPropertyToday(timezone?: string | null, date = new Date()) {
  let formatter: Intl.DateTimeFormat;

  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }

  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return year && month && day ? `${year}-${month}-${day}` : date.toISOString().slice(0, 10);
}

export function formatPropertyDate(
  date: string,
  options: Intl.DateTimeFormatOptions,
  locale = "en-US",
) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, {
    ...options,
    timeZone: "UTC",
  });
}

export function addPropertyDays(date: string, days: number) {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return date;
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

// Revenue and average daily rate are finance cards; desk roles see stays, not takings (VAY-2152).
export function canSeeDashboardFinance(permissions: readonly string[]) {
  return permissions.includes("pms.dashboard.finance.read");
}

export function isDashboardBooking(booking: Booking) {
  return DASHBOARD_BOOKING_STATUSES.has(booking.status);
}

export function isCheckedInArrival(booking: Booking) {
  return Boolean(booking.checkedInAt) || CHECKED_IN_STATUSES.has(booking.status);
}

export function isCheckedOutDeparture(booking: Booking) {
  return CHECKED_OUT_STATUSES.has(booking.status);
}

export function isNotCheckedInDeparture(booking: Booking) {
  return NOT_CHECKED_IN_DEPARTURE_STATUSES.has(booking.status);
}

export function getDashboardBookings(bookings: Booking[]) {
  return bookings.filter(isDashboardBooking);
}

export function getArrivalsToday(bookings: Booking[], today: string) {
  return getDashboardBookings(bookings).filter(
    (booking) => booking.checkIn === today && !isCheckedInArrival(booking),
  );
}

export function getDeparturesToday(bookings: Booking[], today: string) {
  return getDashboardBookings(bookings)
    .filter((booking) => booking.checkOut === today)
    .sort((a, b) => {
      // Not-checked-in (most urgent) first, then checked-in, then checked-out last.
      const aNotIn = isNotCheckedInDeparture(a);
      const bNotIn = isNotCheckedInDeparture(b);
      if (aNotIn !== bNotIn) return aNotIn ? -1 : 1;
      const aCheckedOut = isCheckedOutDeparture(a);
      const bCheckedOut = isCheckedOutDeparture(b);
      if (aCheckedOut === bCheckedOut) return 0;
      return aCheckedOut ? 1 : -1;
    });
}

export function getRemainingArrivals(arrivals: Booking[]) {
  return arrivals.filter((booking) => !isCheckedInArrival(booking)).length;
}

export function getRemainingDepartures(departures: Booking[]) {
  return departures.filter((booking) => !isCheckedOutDeparture(booking)).length;
}

export function isResolvedDeparture(booking: Booking) {
  return isCheckedOutDeparture(booking);
}

/** One night's occupancy over every room of the property, as the Calendar lists them: occupied
 * rooms ÷ all rooms. Blocked and closed rooms still count as rooms, never as occupied (VAY-2563). */
export function getDashboardOccupancy(days: DashboardInventoryDay[], date: string) {
  const matchingDays = days.filter((day) => day.stayDate === date);
  const sum = (count: (day: DashboardInventoryDay) => number) =>
    matchingDays.reduce((total, day) => total + count(day), 0);
  const occupiedUnits = sum((day) => day.occupiedCount);
  const totalUnits = sum((day) => day.totalCount);

  return {
    occupiedUnits,
    totalUnits,
    blockedUnits: sum((day) => day.blockedCount),
    percentage: totalUnits > 0 ? Math.round((occupiedUnits / totalUnits) * 100) : null,
  };
}

// Paid as far as the dashboard can tell; an amount Airbnb never confirmed is never "paid".
export function isDashboardBookingPaid(booking: Booking) {
  if (booking.amountStatus === "unverified") return false;
  return ["captured", "paid", "refunded", "partially_refunded"].includes(
    booking.paymentStatus || "",
  );
}

/** "Revenue This Month": the stays that arrived from the 1st through today, cancelled ones left
 * out, in the hotel's currency only (VAY-2390). The part not paid yet and the Airbnb amounts the PMS
 * couldn't confirm after a change are shown as parts of the total, never instead of it (VAY-2563). */
export function getMonthToDateRevenue(bookings: Booking[], today: string, currency: string) {
  const monthStart = `${today.slice(0, 7)}-01`;
  const arrived = getDashboardBookings(bookings).filter(
    (booking) => booking.checkIn >= monthStart && booking.checkIn <= today,
  );
  const revenue = { total: 0, pending: 0, unverified: 0, otherCurrencies: false };
  for (const booking of arrived) {
    if (booking.currency !== currency) {
      revenue.otherCurrencies = true;
      continue;
    }
    revenue.total += booking.totalAmount;
    if (booking.amountStatus === "unverified") revenue.unverified += booking.totalAmount;
    else if (!isDashboardBookingPaid(booking))
      revenue.pending += Math.max(0, booking.balanceAmount);
  }
  return revenue;
}
