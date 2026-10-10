import {
  resolveBookedCancellationOutcome,
  type BookedCancellationOutcome,
  type BookedCancellationRoom,
} from "@vayada/domain-booking";
import { parsePmsInventoryReservationBundle } from "@vayada/domain-pms";
import type { PoolClient } from "pg";
import type {
  DirectBookingInventoryReservationPort,
  InventoryReservationTransaction,
} from "../platform/inventoryReservation.js";
import { loadCurrentPricingAcceptance } from "./pricingAcceptanceAmendments.js";
import { cancelHostBookingAssignments } from "./pmsHostBookingCancellation.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";

/** Pricing-v2 stays keep their booked terms in the immutable acceptance, never in booking
 * metadata. A date change (VAY-2110) moves the stay to its latest amendment's quote: its dates and
 * prices (what the guest now owes) set the base, but the cancellation terms stay the ones the
 * guest accepted, since an amendment pins the rooms and offers, not their terms. Days count in the
 * property timezone the guest accepted under. Null when the acceptance is missing or its current
 * quote no longer describes the stay. */
export async function loadPricingBookingCancellation(
  client: InventoryReservationTransaction,
  input: {
    propertyId: string;
    guestBookingId: string;
    stay: { checkIn: string; checkOut: string; roomCount: number; currency: string };
    cancelledAt: Date;
  },
): Promise<BookedCancellationOutcome | null> {
  const current = await loadCurrentPricingAcceptance(client as Pick<PoolClient, "query">, input);
  const quote = current?.quote;
  const { checkIn, checkOut, roomCount, currency } = input.stay;
  if (
    !current ||
    !quote ||
    quote.stay.checkIn !== checkIn ||
    quote.stay.checkOut !== checkOut ||
    quote.stay.rooms.length !== roomCount ||
    quote.stay.currency !== currency
  )
    return null;
  const rooms: BookedCancellationRoom[] = [];
  const booked = current.acceptance.quote.evidence.terms;
  for (const room of quote.stay.rooms) {
    const terms = booked.find(
      (t) => t.roomTypeId === room.roomTypeId && t.offerId === room.offerId,
    );
    if (!terms) return null;
    const subtotal = quote.evidence.lines
      .filter((line) => line.selectionId === room.selectionId)
      .reduce(
        (sum, line) => sum + BigInt(line.amountMinor) * (line.kind === "discount" ? -1n : 1n),
        0n,
      );
    rooms.push({
      selectionId: room.selectionId,
      cancellation: terms.cancellation,
      subtotalMinor: subtotal.toString(),
    });
  }
  return resolveBookedCancellationOutcome({
    checkIn: quote.stay.checkIn,
    cancelledOn: localDate(current.acceptance.propertyTimeZone, input.cancelledAt),
    totalMinor: quote.evidence.totalMinor,
    rooms,
  });
}

/** Frees a cancelled, declined, expired or withdrawn v2 stay inside the caller's transaction:
 * the holds of its current quote (the latest date-change amendment's, else the acceptance's).
 * Nothing consumes the old `pms.reservation.cancel` handoff for these stays. Receipts still
 * reserved (adoption pending, or a request never adopted) are released, so a later adoption fails
 * closed; handed-off receipts are left alone and their adopted PMS assignments are cancelled.
 * Inventory and assignments only: the caller owns status, events, notifications and money.
 * Idempotent: a stay already freed returns zero counts. A caller that already released the
 * bundle from booking metadata (guest cancel) sees `released` 0. */
export async function cancelAcceptedPricingStay(
  client: PoolClient,
  port: DirectBookingInventoryReservationPort,
  input: {
    propertyId: string;
    guestBookingId: string;
    commandId: string;
    fingerprint: string;
    occurredAt: Date;
  },
): Promise<{ released: number; canceledAssignments: number }> {
  await lockPmsInventoryMutationScope(client, input.propertyId);
  const reservation =
    (await loadCurrentPricingAcceptance(client, input))?.reservation ??
    (await storedPricingHolds(client, input));
  if (!reservation) throw new Error("Accepted pricing inventory is unavailable");
  const reserved = await client.query(
    `SELECT 1 FROM pms.inventory_reservation_statuses WHERE receipt_id=ANY($1::uuid[]) AND lifecycle_state='reserved'`,
    [reservation.receipts.map((receipt) => receipt.receiptId)],
  );
  await port.release({
    transaction: client,
    propertyId: input.propertyId,
    reservation,
    occurredAt: input.occurredAt,
  });
  const canceledAssignments = await cancelHostBookingAssignments(client, {
    propertyId: input.propertyId,
    bookingId: input.guestBookingId,
    previewId: input.commandId,
    fingerprint: input.fingerprint,
    occurredAt: input.occurredAt,
  });
  return { released: reserved.rows.length, canceledAssignments };
}

/** Freeing a stay must never get stuck. Every acceptance decoded when it was written, so this
 * only covers a decoder that later turns stricter: release the stored holds (the latest
 * amendment's, else the acceptance's) without the full decode, and say so. */
async function storedPricingHolds(
  client: PoolClient,
  input: { propertyId: string; guestBookingId: string },
) {
  const row = (
    await client.query(
      `SELECT COALESCE((SELECT amendment.inventory_reservation_bundle
           FROM booking.pricing_acceptance_amendments amendment
           WHERE amendment.acceptance_id=acceptance.id ORDER BY amendment.revision DESC LIMIT 1),
         acceptance.inventory_reservation_bundle) AS bundle
       FROM booking.pricing_quote_acceptances acceptance
       WHERE acceptance.property_id=$1::uuid AND acceptance.guest_booking_id=$2::uuid`,
      [input.propertyId, input.guestBookingId],
    )
  ).rows[0];
  const reservation = parsePmsInventoryReservationBundle(row?.bundle);
  if (reservation)
    console.warn("Pricing acceptance no longer decodes; releasing its stored holds.", {
      propertyId: input.propertyId,
      guestBookingId: input.guestBookingId,
    });
  return reservation;
}

function localDate(timeZone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
