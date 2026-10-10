import type { Booking } from "@/services/bookings";

export type BookingBalanceStatus =
  | "unverified"
  | "paid"
  | "partial"
  | "due"
  | "refunded"
  | "closed";

type BalanceFields = Pick<
  Booking,
  | "amountStatus"
  | "status"
  | "paymentStatus"
  | "depositRequired"
  | "depositAmount"
  | "balanceAmount"
>;

// Booking payment states are unpaid, authorized, partially_paid, paid, refunded, failed and
// waived; "captured" is the older provider spelling of paid.
const PAID_STATES = ["paid", "captured"];

/** Balance badge for the Reservations list. A cancelled, declined or expired booking owes nothing
 * the PMS collects (its cancel command retains no charges), so it never shows "Due" (VAY-2089). */
export function getBalanceStatus(b: BalanceFields): BookingBalanceStatus {
  if (b.amountStatus === "unverified") return "unverified";
  const paid = PAID_STATES.includes(b.paymentStatus ?? "");
  if (b.status === "cancelled" || b.status === "declined" || b.status === "expired") {
    if (b.paymentStatus === "refunded") return "refunded";
    return paid ? "paid" : "closed";
  }
  if (b.depositRequired && b.depositAmount > 0) {
    if (b.balanceAmount <= 0) return "paid";
    return paid ? "partial" : "due";
  }
  if (paid) return "paid";
  if (b.paymentStatus === "authorized" || b.paymentStatus === "partially_paid") return "partial";
  return "due";
}
