import { Booking } from "@/services/bookings";

const DASHBOARD_BOOKING_STATUSES = new Set<Booking["status"]>([
  "confirmed",
  "checked_in",
  "in_house",
]);

const CHECKED_IN_STATUSES = new Set<Booking["status"]>(["checked_in", "in_house"]);

export function getPropertyToday(timezone?: string | null) {
  const date = new Date();
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

export function isDashboardBooking(booking: Booking) {
  return DASHBOARD_BOOKING_STATUSES.has(booking.status);
}

export function isCheckedInArrival(booking: Booking) {
  return CHECKED_IN_STATUSES.has(booking.status);
}

export function getDashboardBookings(bookings: Booking[]) {
  return bookings.filter(isDashboardBooking);
}

export function getArrivalsToday(bookings: Booking[], today: string) {
  return getDashboardBookings(bookings)
    .filter((booking) => booking.checkIn === today)
    .sort((a, b) => {
      const aCheckedIn = isCheckedInArrival(a);
      const bCheckedIn = isCheckedInArrival(b);
      if (aCheckedIn === bCheckedIn) return 0;
      return aCheckedIn ? 1 : -1;
    });
}

export function getDeparturesToday(bookings: Booking[], today: string) {
  return getDashboardBookings(bookings).filter((booking) => booking.checkOut === today);
}

export function getRemainingArrivals(arrivals: Booking[]) {
  return arrivals.filter((booking) => !isCheckedInArrival(booking)).length;
}

export function getOccupiedTonight(bookings: Booking[], today: string) {
  return getDashboardBookings(bookings).filter(
    (booking) => booking.checkIn <= today && booking.checkOut > today,
  ).length;
}
