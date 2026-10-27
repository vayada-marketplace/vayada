import type { Booking, DeskSettlementMethod } from "@/services/bookings";
import type { CheckinSettlementOption } from "@/services/settings";

/** How the balance is settled at check-in (VAY-2373 D2): nothing is charged online; card means the
 * hotel's own terminal. */
export type DeskMethod = "card" | "cash" | "bank_transfer";
export type PaymentChoice =
  | { kind: "collect"; method: DeskMethod }
  | { kind: "at_checkout" }
  | { kind: "already_paid" };

const DESK_METHODS: DeskMethod[] = ["card", "cash", "bank_transfer"];

/** The ways to collect now that Settings → Check-in offers, in the approved order. */
export function deskMethods(options: CheckinSettlementOption[]): DeskMethod[] {
  return DESK_METHODS.filter((method) => options.includes(method));
}

/** What mark-paid records for a choice; null when nothing is recorded now. */
export function settlementMethodFor(choice: PaymentChoice): DeskSettlementMethod | null {
  if (choice.kind === "collect") return choice.method === "card" ? "manual_card" : choice.method;
  if (choice.kind === "already_paid") return "other";
  return null;
}

/** The booking's balance the desk can record as paid; the same cases the booking page offers. */
export function deskPayableBalance(
  booking: Pick<Booking, "amountStatus" | "paymentMethod" | "paymentStatus" | "status">,
): "transfer" | "atProperty" | "cardRest" | null {
  if (booking.amountStatus === "unverified") return null;
  // VAY-2205: a card deposit leaves the rest to pay at the hotel, also once the guest is in: check-in
  // moves the room assignments, the booking itself stays confirmed.
  if (
    booking.paymentMethod === "card" &&
    booking.paymentStatus === "partially_paid" &&
    ["confirmed", "checked_in", "in_house", "checked_out"].includes(booking.status)
  )
    return "cardRest";
  if (booking.status !== "confirmed" || booking.paymentStatus !== "unpaid") return null;
  if (booking.paymentMethod === "bank_transfer") return "transfer";
  if (booking.paymentMethod === "pay_at_property") return "atProperty";
  return null;
}

/** An add-on added at the desk, one desk charge each (VAY-2373 D3). */
export interface DeskAddon {
  addonId: string;
  label: string;
  amount: number;
}
export interface DeskCharge extends DeskAddon {
  chargeId: string;
  paid: boolean;
}

/** What to create and what to waive so the desk charges match the add-ons now added. A paid
 * charge is never waived. */
export function deskChargeChanges(
  added: DeskAddon[],
  created: DeskCharge[],
): { create: DeskAddon[]; waive: DeskCharge[] } {
  const same = (a: DeskAddon, b: DeskAddon) =>
    a.addonId === b.addonId && a.label === b.label && a.amount === b.amount;
  return {
    create: added.filter((addon) => !created.some((charge) => same(addon, charge))),
    waive: created.filter((charge) => !charge.paid && !added.some((addon) => same(addon, charge))),
  };
}
