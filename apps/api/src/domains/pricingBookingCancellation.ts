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
import { decodePricingAcceptanceHistory } from "./pricingAcceptanceHistory.js";
import { cancelHostBookingAssignments } from "./pmsHostBookingCancellation.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";

/** Pricing-v2 stays keep their booked terms in the immutable acceptance, never in booking
 * metadata. Days count in the property timezone the guest booked under, frozen with the terms.
 * Null when the acceptance is missing or no longer describes the stay. */
export async function loadPricingBookingCancellation(
  client: InventoryReservationTransaction,
  input: {
    propertyId: string;
    guestBookingId: string;
    stay: { checkIn: string; checkOut: string; roomCount: number; currency: string };
    cancelledAt: Date;
  },
): Promise<BookedCancellationOutcome | null> {
  const row = (
    await client.query<Record<string, unknown>>(
      `SELECT * FROM booking.pricing_quote_acceptances WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid`,
      [input.propertyId, input.guestBookingId],
    )
  ).rows[0];
  if (!row) return null;
  const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
  const history = decodePricingAcceptanceHistory(
    {
      ...row,
      accepted_at: iso(row.accepted_at),
      finance_terms_captured_at: iso(row.finance_terms_captured_at),
    },
    input.propertyId,
    String(row.organization_id),
  );
  const quote = history?.quote;
  const { checkIn, checkOut, roomCount, currency } = input.stay;
  if (
    !history ||
    !quote ||
    quote.stay.checkIn !== checkIn ||
    quote.stay.checkOut !== checkOut ||
    quote.stay.rooms.length !== roomCount ||
    quote.stay.currency !== currency
  )
    return null;
  const rooms: BookedCancellationRoom[] = [];
  for (const room of quote.stay.rooms) {
    const terms = quote.evidence.terms.find(
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
    cancelledOn: localDate(history.propertyTimeZone, input.cancelledAt),
    totalMinor: quote.evidence.totalMinor,
    rooms,
  });
}

/** Frees a cancelled, declined, expired or withdrawn v2 stay inside the caller's transaction.
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
  const row = (
    await client.query(
      `SELECT inventory_reservation_bundle AS bundle FROM booking.pricing_quote_acceptances
       WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid`,
      [input.propertyId, input.guestBookingId],
    )
  ).rows[0];
  const reservation = parsePmsInventoryReservationBundle(row?.bundle);
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
