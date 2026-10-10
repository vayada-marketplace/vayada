import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import type { StoredPricingQuote } from "@vayada/domain-booking";
import { parsePmsInventoryReservationBundle, pricingCurrencyScale } from "@vayada/domain-pms";
import {
  hostPolicyImpact,
  type HostPolicyImpact,
  type SingleHostPolicyImpact,
} from "./bookingHostPolicyImpact.js";
import type { BookingHostActionGuards } from "./bookingHostActionGuards.js";
import { lockCurrentPricingQuote } from "./currentPricingQuote.js";
import {
  loadCurrentPricingAcceptance,
  type CurrentPricingAcceptance,
} from "./pricingAcceptanceAmendments.js";
import { pricingRoomRevenueProjection } from "./pricingRoomRevenueProjection.js";
import { reservePmsQuoteInventory } from "./pmsInventoryReservationLifecycleRepository.js";
import { lockPublicPricingPublication } from "./publicPricingPublication.js";
import { publicPricingOfferBindings } from "./publicPricingRoomStay.js";
import { persistDirectNightlyRevenueProjection } from "./stripeBookingSettlement.js";
import type {
  DirectBookingInventoryReservationPort,
  InventoryReservationReceipt,
} from "../platform/inventoryReservation.js";

/** Moving a confirmed pricing-v2 stay to new dates (VAY-2110): the same rooms, offers and
 * guests, repriced from the current publication, keeping the cancellation and payment terms the
 * guest booked. Whatever this first version can't carry over safely is refused with a reason. */
export class PricingStayDateChangeRefused extends Error {
  constructor(
    message: string,
    readonly code: PricingStayDateChangeRefusal = "unsupported_edit",
  ) {
    super(message);
  }
}
type PricingStayDateChangeRefusal = "unsupported_edit" | "inventory_unavailable" | "stale_preview";
const refuse = (message: string, code?: PricingStayDateChangeRefusal): never => {
  throw new PricingStayDateChangeRefused(message, code);
};

export type PricingStayDateChangeBooking = {
  guestBookingId: string;
  propertyId: string;
  checkIn: string;
  checkOut: string;
  roomCount: number;
  currency: string;
  totalAmount: string | number;
};

export type PricingStayDateChange = {
  current: CurrentPricingAcceptance;
  quote: StoredPricingQuote;
  calculation: Record<string, unknown>;
  requestedCheckIn: string;
  requestedCheckOut: string;
  oldTotal: number;
  newTotal: number;
  /** The price without the quote's identity and clock, so a preview and its apply compare. */
  fingerprint: string;
  cancellationPolicy: HostPolicyImpact;
  revenue: NonNullable<ReturnType<typeof pricingRoomRevenueProjection>>;
};

type DateMove = {
  propertyId: string;
  bookingId: string;
  previewId: string;
  /** The booking's current holds, as its metadata records them. */
  reservation: InventoryReservationReceipt;
  occurredAt: Date;
  inventory: DirectBookingInventoryReservationPort;
  guards: Pick<BookingHostActionGuards, "prepareDateEdit" | "completeDateEdit">;
  /** Holds the new nights for the repriced quote; the pricing-v2 quote reservation by default. */
  reserveHolds?: PricingStayHoldReserver;
};

export type PricingStayHoldReserver = (
  client: PoolClient,
  input: {
    organizationId: string;
    propertyId: string;
    quoteId: string;
    checkIn: string;
    checkOut: string;
    rooms: readonly { roomTypeId: string }[];
  },
) => Promise<unknown>;

/** The pricing-v2 checkout's reservation: current calendar, room facts and capacity checks. */
const reserveQuoteHolds: PricingStayHoldReserver = async (client, input) =>
  (await reservePmsQuoteInventory(client, input, async () => {})).bundle;

const dateOnly = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map(
            (key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
          )
          .join(",")}}`
      : JSON.stringify(value);
const decimal = (minor: string, scale: number) => {
  const digits = BigInt(minor)
    .toString()
    .padStart(scale + 1, "0");
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
};
const discounted = (quote: StoredPricingQuote) =>
  quote.stay.promoCode !== null ||
  quote.evidence.lines.some((line) => line.kind === "discount" && line.amountMinor !== "0");

/** The repriced stay keeps what the guest booked: the same rooms, offers and guests, each
 * room's cancellation and payment terms and meal, the payment method and acceptance mode. */
export function keepsBookedTerms(booked: StoredPricingQuote, quote: StoredPricingQuote) {
  const termsOf = (q: StoredPricingQuote, room: StoredPricingQuote["stay"]["rooms"][number]) => {
    const terms = q.evidence.terms.find(
      (t) => t.roomTypeId === room.roomTypeId && t.offerId === room.offerId,
    );
    return terms && { cancellation: terms.cancellation, payment: terms.payment };
  };
  const mealOf = (q: StoredPricingQuote, selectionId: string) =>
    q.rooms.find((room) => room.selectionId === selectionId)?.mealPlan;
  return (
    quote.stay.rooms.length === booked.stay.rooms.length &&
    booked.stay.rooms.every((room, index) => {
      const next = quote.stay.rooms[index]!;
      const terms = termsOf(booked, room);
      return (
        next.selectionId === room.selectionId &&
        next.roomTypeId === room.roomTypeId &&
        next.offerId === room.offerId &&
        isDeepStrictEqual(next.guests, room.guests) &&
        terms !== undefined &&
        isDeepStrictEqual(termsOf(quote, next), terms) &&
        mealOf(quote, room.selectionId) === mealOf(booked, room.selectionId)
      );
    }) &&
    quote.paymentMethod === booked.paymentMethod &&
    quote.acceptanceMode === booked.acceptanceMode
  );
}

export type PricingStayRepricer = (
  client: PoolClient,
  input: { propertyId: string; booked: StoredPricingQuote; checkIn: string; checkOut: string },
) => Promise<{ quote: StoredPricingQuote; calculation: Record<string, unknown> } | null>;

/** The booked rooms, offers and guests priced for new dates from the hotel's current public
 * publication, as the booking engine would price them today. */
export const repriceFromPublication: PricingStayRepricer = async (client, input) => {
  const slugs = (
    await client.query<{ slug: string }>(
      `SELECT slug FROM hotel_catalog.property_slugs
       WHERE property_id=$1::uuid AND locale IS NULL AND purpose='canonical' AND status='active'`,
      [input.propertyId],
    )
  ).rows;
  const slug = slugs.length === 1 ? slugs[0]!.slug : null;
  const publication = slug ? await lockPublicPricingPublication(client, slug) : null;
  if (!slug || !publication)
    return refuse("This hotel's prices aren't published, so the new dates can't be priced.");
  const bindings = publicPricingOfferBindings(publication);
  const rooms = input.booked.stay.rooms.map((room) => ({
    selectionId: room.selectionId,
    guests: room.guests,
    publicOfferKey: bindings.find(
      (binding) => binding.roomTypeId === room.roomTypeId && binding.offerId === room.offerId,
    )?.publicOfferKey,
  }));
  if (rooms.some((room) => !room.publicOfferKey))
    return refuse("The booked rate isn't offered any more, so the new dates can't be priced.");
  const priced = await lockCurrentPricingQuote(
    client,
    slug,
    {
      version: "public-pricing-selection.v1",
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      currency: input.booked.stay.currency,
      addons: [],
      promoCode: null,
      rooms,
    },
    input.booked.paymentMethod,
    900,
  );
  return priced && { quote: priced.quote, calculation: priced.calculation };
};

/** Reprice new dates for a confirmed pricing-v2 stay. Caller holds the booking row and the
 * property's inventory lock in a READ COMMITTED transaction; nothing is written. */
export async function quotePricingStayDateChange(
  client: PoolClient,
  input: {
    booking: PricingStayDateChangeBooking;
    request: { checkIn?: string; checkOut?: string };
    /** Today at the property. */
    today: string;
    reprice: PricingStayRepricer;
  },
): Promise<PricingStayDateChange> {
  const { booking } = input;
  const checkIn = input.request.checkIn,
    checkOut = input.request.checkOut;
  if (!dateOnly(checkIn) || !dateOnly(checkOut) || checkIn >= checkOut)
    return refuse("Valid check-in and check-out dates are required.");
  if (checkIn < input.today) return refuse("Check-in cannot be in the past.");
  if (checkIn === booking.checkIn && checkOut === booking.checkOut)
    return refuse("Choose different dates to change this booking.");
  const current = await loadCurrentPricingAcceptance(client, {
    propertyId: booking.propertyId,
    guestBookingId: booking.guestBookingId,
  });
  const booked = current?.quote;
  const editRevision = (
    await client.query<{ editRevision: number }>(
      `SELECT edit_revision AS "editRevision" FROM booking.guest_bookings
       WHERE id=$1::uuid AND property_id=$2::uuid`,
      [booking.guestBookingId, booking.propertyId],
    )
  ).rows[0]?.editRevision;
  if (
    !current ||
    !booked ||
    editRevision !== current.editRevision ||
    booked.stay.checkIn !== booking.checkIn ||
    booked.stay.checkOut !== booking.checkOut ||
    booked.stay.rooms.length !== booking.roomCount ||
    booked.stay.currency !== booking.currency
  )
    return refuse("This booking's accepted price can't be found, so its dates can't change here.");
  if (booked.acceptanceMode === "request")
    return refuse("Booking requests can't change dates here yet.");
  if (booked.stay.addons.length)
    return refuse("Bookings with add-ons can't change dates here yet.");
  if (discounted(booked)) return refuse("Discounted bookings can't change dates here yet.");
  if (
    (
      await client.query(
        "SELECT 1 FROM booking.affiliate_original_booking_bindings WHERE booking_id=$1",
        [booking.guestBookingId],
      )
    ).rowCount
  )
    return refuse("Bookings that came through an affiliate can't change dates here yet.");
  // The PMS must have adopted the stay: its assignments carry the holds that move.
  const adopted = (
    await client.query<{ rooms: number }>(
      `SELECT count(*)::int AS rooms FROM pms.operational_booking_assignments assignment
       JOIN pms.inventory_reservation_statuses status
         ON status.receipt_id::text=assignment.assignment_payload#>>'{inventoryReservation,receiptId}'
       WHERE assignment.property_id=$1::uuid AND assignment.guest_booking_id=$2::uuid
         AND assignment.source='direct_booking'
         AND assignment.assignment_status NOT IN ('canceled','released')
         AND status.lifecycle_state='handed_off'`,
      [booking.propertyId, booking.guestBookingId],
    )
  ).rows[0]?.rooms;
  if (adopted !== booking.roomCount)
    return refuse("This booking is still being set up in the PMS. Try again in a few minutes.");
  const priced = await input.reprice(client, {
    propertyId: booking.propertyId,
    booked,
    checkIn,
    checkOut,
  });
  if (!priced)
    return refuse(
      "The new dates can't be priced: the rate may be closed or restricted on those dates.",
    );
  const quote = priced.quote;
  if (!keepsBookedTerms(booked, quote))
    return refuse(
      "This rate's terms changed since the booking, so its dates can't change here. Cancel and rebook instead.",
    );
  if (discounted(quote))
    return refuse("A discount applies on the new dates, which a date change can't carry yet.");
  const revenue = pricingRoomRevenueProjection(quote, priced.calculation.charges);
  if (!revenue)
    return refuse("The new price includes charges that a date change can't record yet.");
  const cancellationPolicy = await bookedPolicyImpact(client, {
    propertyId: booking.propertyId,
    booked,
    checkIn: booking.checkIn,
    newCheckIn: checkIn,
    timezone: current.acceptance.propertyTimeZone,
  });
  if (!cancellationPolicy)
    return refuse("Bookings with partial-refund terms can't change dates here yet.");
  const scale = pricingCurrencyScale(quote.stay.currency);
  // Booking totals keep two decimals; a total that needs more can't be stored exactly.
  if (
    scale === null ||
    (scale > 2 && BigInt(quote.evidence.totalMinor) % 10n ** BigInt(scale - 2) !== 0n)
  )
    return refuse("The new total can't be recorded in this booking's currency.");
  return {
    current,
    quote,
    calculation: priced.calculation as Record<string, unknown>,
    requestedCheckIn: checkIn,
    requestedCheckOut: checkOut,
    oldTotal: Number(booking.totalAmount),
    newTotal: Number(decimal(quote.evidence.totalMinor, scale)),
    fingerprint: sha256(
      canonical({
        method: quote.paymentMethod,
        stay: quote.stay,
        rooms: quote.rooms,
        evidence: { ...quote.evidence, issuedAt: null, expiresAt: null },
      }),
    ),
    cancellationPolicy,
    revenue,
  };
}

/** The booked cancellation terms against the old and new check-in, in the acceptance's frozen
 * time zone; null for partial-refund terms, which date-change previews don't explain yet. */
async function bookedPolicyImpact(
  client: PoolClient,
  input: {
    propertyId: string;
    booked: StoredPricingQuote;
    checkIn: string;
    newCheckIn: string;
    timezone: string;
  },
): Promise<HostPolicyImpact | null> {
  const lines: { roomTypeId: string; impact: SingleHostPolicyImpact }[] = [];
  for (const room of input.booked.stay.rooms) {
    const terms = input.booked.evidence.terms.find(
      (t) => t.roomTypeId === room.roomTypeId && t.offerId === room.offerId,
    );
    if (!terms) return null;
    const impact = hostPolicyImpact(
      terms.cancellation.kind === "flexible" ? terms.cancellation.terms : {},
      { rateType: terms.cancellation.kind },
      input.checkIn,
      input.newCheckIn,
      input.timezone,
    );
    if (!impact) return null;
    lines.push({ roomTypeId: room.roomTypeId, impact });
  }
  const first = lines[0]?.impact;
  if (!first) return null;
  if (lines.every((line) => isDeepStrictEqual(line.impact, first))) return first;
  const names = new Map(
    (
      await client.query<{ id: string; name: string }>(
        "SELECT id::text,name FROM pms.room_types WHERE property_id=$1::uuid AND id=ANY($2::uuid[])",
        [input.propertyId, [...new Set(lines.map((line) => line.roomTypeId))]],
      )
    ).rows.map((row) => [row.id, row.name]),
  );
  const grouped = new Map<string, { impact: SingleHostPolicyImpact; roomCount: number }>();
  for (const line of lines)
    grouped.set(line.roomTypeId, {
      impact: line.impact,
      roomCount: (grouped.get(line.roomTypeId)?.roomCount ?? 0) + 1,
    });
  return {
    type: "mixed_room",
    previousDeadline: null,
    newDeadline: null,
    timezone: input.timezone,
    lines: [...grouped].map(([roomTypeId, line]) => ({
      ...line.impact,
      roomTypeId,
      roomName: names.get(roomTypeId) ?? roomTypeId,
      roomCount: line.roomCount,
    })),
  };
}

/** Free the booking's own nights and hold the new ones. Caller owns the transaction. */
async function moveHolds(client: PoolClient, change: PricingStayDateChange, move: DateMove) {
  const previous = await move.guards.prepareDateEdit(client, {
    propertyId: move.propertyId,
    bookingId: move.bookingId,
    previewId: move.previewId,
    receipt: move.reservation,
    occurredAt: move.occurredAt,
  });
  if (!previous)
    return refuse("This booking is still being set up in the PMS. Try again in a few minutes.");
  await move.inventory.release({
    transaction: client,
    propertyId: move.propertyId,
    reservation: move.reservation,
    occurredAt: move.occurredAt,
  });
  let held;
  try {
    held = await (move.reserveHolds ?? reserveQuoteHolds)(client, {
      organizationId: change.current.acceptance.organizationId,
      propertyId: move.propertyId,
      quoteId: change.quote.quoteId,
      checkIn: change.requestedCheckIn,
      checkOut: change.requestedCheckOut,
      rooms: change.quote.stay.rooms,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Quote inventory is unavailable")
      return refuse(
        "The new dates are not available for every booked room.",
        "inventory_unavailable",
      );
    throw error;
  }
  const bundle = parsePmsInventoryReservationBundle(held);
  if (!bundle) throw new Error("Pricing stay date change holds did not decode");
  return { previous, bundle };
}

/** Preview only: prove the new nights can be held, then undo every write. */
export async function checkPricingStayDateChangeHolds(
  client: PoolClient,
  change: PricingStayDateChange,
  move: DateMove,
) {
  await client.query("SAVEPOINT pricing_stay_date_change_holds");
  try {
    await moveHolds(client, change, move);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT pricing_stay_date_change_holds");
  }
}

/** Apply a previewed change in the caller's transaction: store the repriced quote, move the
 * holds, append the amendment, then update the booking, its PMS stays and its nightly revenue. */
export async function applyPricingStayDateChange(
  client: PoolClient,
  change: PricingStayDateChange,
  move: DateMove & {
    actorUserId: string;
    requestId: string;
    correlationId: string;
    /** Today at the property. */
    recognizedOn: string;
  },
) {
  const { current, quote } = change;
  const requestId = `host-edit:${move.previewId}`;
  await client.query(
    `INSERT INTO booking.pricing_quotes(id,property_id,organization_id,request_id,request_hash,payload)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [
      quote.quoteId,
      move.propertyId,
      current.acceptance.organizationId,
      requestId,
      sha256(requestId),
      { quote, calculation: change.calculation },
    ],
  );
  const { previous, bundle } = await moveHolds(client, change, move);
  // Before the booking changes, only the new nights may be held. Adopted holds stay handed off (a
  // final state), so the old nights are freed by releasing every assignment; no old hold may
  // still be reserved either. Each new hold is reserved.
  const holds = (
    await client.query<{ oldReserved: number; newReserved: number; occupying: number }>(
      `SELECT
         (SELECT count(*)::int FROM pms.inventory_reservation_statuses
           WHERE receipt_id=ANY($1::uuid[]) AND lifecycle_state='reserved') AS "oldReserved",
         (SELECT count(*)::int FROM pms.inventory_reservation_statuses
           WHERE receipt_id=ANY($2::uuid[]) AND lifecycle_state='reserved') AS "newReserved",
         (SELECT count(*)::int FROM pms.operational_booking_assignments
           WHERE property_id=$3::uuid AND guest_booking_id=$4::uuid
             AND assignment_status NOT IN ('canceled','released')) AS occupying`,
      [
        current.reservation.receipts.map((receipt) => receipt.receiptId),
        bundle.receipts.map((receipt) => receipt.receiptId),
        move.propertyId,
        move.bookingId,
      ],
    )
  ).rows[0]!;
  if (holds.oldReserved || holds.occupying || holds.newReserved !== bundle.receipts.length)
    throw new Error("Pricing stay date change left holds behind");
  await client.query(
    `INSERT INTO booking.pricing_acceptance_amendments
     (acceptance_id,property_id,organization_id,guest_booking_id,revision,edit_revision,
      pricing_quote_id,quote_snapshot,inventory_reservation_bundle,source,source_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'host_edit',$10)`,
    [
      current.acceptance.id,
      move.propertyId,
      current.acceptance.organizationId,
      move.bookingId,
      current.revision + 1,
      current.editRevision + 1,
      quote.quoteId,
      quote,
      bundle,
      move.previewId,
    ],
  );
  const scale = pricingCurrencyScale(quote.stay.currency)!;
  const total = decimal(quote.evidence.totalMinor, scale);
  const updated = (
    await client.query<{ guestBookingId: string; lifecycleStatus: string }>(
      `WITH updated AS (
         UPDATE booking.guest_bookings
            SET check_in=$3::date,check_out=$4::date,total_amount=$5::numeric,balance_amount=$5::numeric,
                edit_revision=$6,booking_metadata=booking_metadata||jsonb_build_object(
                  'pricingQuoteId',$7::text,'inventoryReservation',$8::jsonb),updated_at=$9::timestamptz
          WHERE id=$1::uuid AND property_id=$2::uuid AND lifecycle_status='confirmed'
            AND payment_status='unpaid' AND edit_revision=$10
          RETURNING id,check_in,check_out,total_amount,balance_amount,currency,lifecycle_status
       ), status_event AS (
         INSERT INTO booking.booking_status_events
           (guest_booking_id,event_type,from_status,to_status,actor_type,actor_user_id,public_visible,
            public_message,event_payload,occurred_at)
         SELECT id,'guest_booking.host_dates_updated','confirmed','confirmed','property_user',$11::uuid,
           true,'Booking dates updated.',$12::jsonb,$9::timestamptz FROM updated
       ), summary AS (
         UPDATE booking.direct_booking_summary_read_model summary
            SET check_in=updated.check_in,check_out=updated.check_out,
                amount_summary=jsonb_build_object('totalAmount',updated.total_amount,
                  'balanceAmount',updated.balance_amount,'currency',updated.currency),
                projected_at=$9::timestamptz
           FROM updated WHERE summary.guest_booking_id=updated.id
       )
       SELECT id::text AS "guestBookingId",lifecycle_status AS "lifecycleStatus" FROM updated`,
      [
        move.bookingId,
        move.propertyId,
        change.requestedCheckIn,
        change.requestedCheckOut,
        total,
        current.editRevision + 1,
        quote.quoteId,
        bundle,
        move.occurredAt.toISOString(),
        current.editRevision,
        move.actorUserId,
        {
          requestId: move.requestId,
          correlationId: move.correlationId,
          changeRequestId: move.previewId,
          pricingQuoteId: quote.quoteId,
          oldCheckIn: current.quote.stay.checkIn,
          oldCheckOut: current.quote.stay.checkOut,
          requestedCheckIn: change.requestedCheckIn,
          requestedCheckOut: change.requestedCheckOut,
          oldTotal: change.oldTotal,
          newTotal: change.newTotal,
          currency: quote.stay.currency,
        },
      ],
    )
  ).rows[0];
  if (!updated)
    return refuse("The booking changed. Preview the date change again.", "stale_preview");
  // The PMS hands the new holds off at commit at the assignments' update time, which must not
  // precede their reserve time; reservePmsQuoteInventory stamps that with the database clock.
  const completedAt = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now"))
    .rows[0]!.now;
  await move.guards.completeDateEdit(client, {
    propertyId: move.propertyId,
    bookingId: move.bookingId,
    previewId: move.previewId,
    previous,
    receipt: bundle,
    checkIn: change.requestedCheckIn,
    checkOut: change.requestedCheckOut,
    occurredAt: completedAt,
  });
  // Reversed old nights are recognized today, never in a closed earlier period.
  await persistDirectNightlyRevenueProjection(
    client,
    { guestBookingId: move.bookingId, propertyId: move.propertyId },
    { ...change.revenue, recognizedOn: move.recognizedOn },
  );
  return updated;
}
