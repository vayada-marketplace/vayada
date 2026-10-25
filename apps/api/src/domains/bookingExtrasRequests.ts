import type { PoolClient, QueryResultRow } from "pg";
import { addonLeadTimeAllows } from "./addonLeadTime.js";
import { checkInLeadAllows, readPricingCheckInPlace } from "./pricingManualPaymentLead.js";
import { readCurrentPublicAddons } from "./replacementAddons.js";

type Db = Pick<PoolClient, "query">;
type PricingModel = "per_stay" | "per_night" | "per_guest" | "per_guest_night";

/** An extra a booked guest can ask for (VAY-2360 part 3), priced for the whole stay at quantity one. */
export type ExtraOffer = {
  addonId: string;
  name: string;
  pricingModel: PricingModel;
  unitMinor: string;
  amountMinor: string;
  currency: string;
  guests: number;
  nights: number;
};

/** A guest's extras request: a `booking.booking_change_requests` row of type `addon_change` (D4 A, P1). The
 * hotel accepts or declines it; accepting doesn't change the booking's total (P2), the hotel charges the
 * extras at check-in. */
export type ExtrasRequest = {
  id: string;
  status: "pending" | "accepted" | "declined" | "canceled" | "expired";
  items: ExtraOffer[];
  totalMinor: string;
  currency: string;
  createdAt: string;
  decidedAt: string | null;
  note: string | null;
};

const VERSION = "booking-extras-request.v1";

/** An extra's amount for the stay, as the quote prices one (replacementAddonAmounts): per guest counts every
 * guest, per night every night. */
export function extraAmountMinor(
  unitMinor: string,
  model: PricingModel,
  stay: { guests: number; nights: number },
): string {
  const people = model === "per_guest" || model === "per_guest_night" ? stay.guests : 1;
  const days = model === "per_night" || model === "per_guest_night" ? stay.nights : 1;
  return String(BigInt(unitMinor) * BigInt(people) * BigInt(days));
}

/** The extras a confirmed stay can still ask for: the hotel's current public add-ons in the stay's currency
 * (with its booking page's add-ons switched on), that the stay hasn't booked, that fit its guests and whose
 * notice its check-in still gives. Nothing once check-in has come. */
export async function loadOfferedExtras(
  db: Db,
  input: {
    propertyId: string;
    guestBookingId: string;
    currency: string;
    checkIn: string;
    nights: number;
    guests: number;
  },
): Promise<ExtraOffer[]> {
  const settings = (
    await db.query(
      "SELECT show_addons_step, addons_enabled FROM booking.booking_settings WHERE property_id=$1::uuid",
      [input.propertyId],
    )
  ).rows[0];
  if (settings?.show_addons_step === false || settings?.addons_enabled === false) return [];
  const place = await readPricingCheckInPlace(db, input.propertyId);
  if (!place || !checkInLeadAllows({ hours: 0, checkIn: input.checkIn, ...place })) return [];
  const [addons, booked] = await Promise.all([
    readCurrentPublicAddons(db, { propertyId: input.propertyId, currency: input.currency }),
    db.query<{ id: string }>(
      `SELECT DISTINCT addon_definition_id::text AS id FROM booking.active_booking_addon_selections
       WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid AND addon_definition_id IS NOT NULL`,
      [input.propertyId, input.guestBookingId],
    ),
  ]);
  const taken = new Set(booked.rows.map((row) => row.id));
  return addons
    .filter(
      (addon) =>
        !addon.legacyLeadTime &&
        !taken.has(addon.id) &&
        !(
          (addon.pricingModel === "per_guest" || addon.pricingModel === "per_guest_night") &&
          addon.maxGuests !== null &&
          addon.maxGuests < input.guests
        ) &&
        (addon.leadTimeHours === null ||
          addonLeadTimeAllows({ hours: addon.leadTimeHours, checkIn: input.checkIn, ...place })),
    )
    .map((addon) => ({
      addonId: addon.id,
      name: addon.name,
      pricingModel: addon.pricingModel,
      unitMinor: addon.amountMinor,
      amountMinor: extraAmountMinor(addon.amountMinor, addon.pricingModel, input),
      currency: addon.currency,
      guests: input.guests,
      nights: input.nights,
    }));
}

const columns = (table: string) => `${table}id::text AS id, ${table}status,
  ${table}requested_changes AS changes, ${table}decision_note AS note, ${table}decided_at AS "decidedAt",
  ${table}created_at AS "createdAt"`;

function serializeRequest(row: QueryResultRow | undefined): ExtrasRequest | null {
  const changes = row?.changes;
  if (!row || !changes || changes.version !== VERSION || !Array.isArray(changes.items)) return null;
  return {
    id: row.id,
    status: row.status,
    items: changes.items,
    totalMinor: changes.totalMinor,
    currency: changes.currency,
    createdAt: new Date(row.createdAt).toISOString(),
    decidedAt: row.decidedAt ? new Date(row.decidedAt).toISOString() : null,
    note: row.note ?? null,
  };
}

/** The booking's latest extras request, of any status. */
export async function loadLatestExtrasRequest(
  db: Db,
  input: { propertyId: string; guestBookingId: string },
): Promise<ExtrasRequest | null> {
  const result = await db.query(
    `SELECT ${columns("r.")}
     FROM booking.booking_change_requests r
     JOIN booking.guest_bookings b ON b.id = r.guest_booking_id
     WHERE b.property_id=$1::uuid AND r.guest_booking_id=$2::uuid AND r.request_type='addon_change'
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT 1`,
    [input.propertyId, input.guestBookingId],
  );
  return serializeRequest(result.rows[0]);
}

/** Stores the guest's request for these extras (already checked against loadOfferedExtras). */
export async function insertExtrasRequest(
  db: Db,
  input: { guestBookingId: string; items: ExtraOffer[] },
): Promise<ExtrasRequest> {
  const totalMinor = String(input.items.reduce((sum, item) => sum + BigInt(item.amountMinor), 0n));
  const result = await db.query(
    `INSERT INTO booking.booking_change_requests
       (guest_booking_id, request_type, requested_by, status, requested_changes)
     VALUES ($1::uuid, 'addon_change', 'guest', 'pending', $2::jsonb)
     RETURNING ${columns("")}`,
    [
      input.guestBookingId,
      JSON.stringify({
        version: VERSION,
        items: input.items,
        totalMinor,
        currency: input.items[0]!.currency,
      }),
    ],
  );
  return serializeRequest(result.rows[0])!;
}

/** The hotel's answer to a pending request; null when the booking has no such pending request. */
export async function decideExtrasRequest(
  db: Db,
  input: {
    propertyId: string;
    guestBookingId: string;
    requestId: string;
    decision: "accepted" | "declined";
    actorUserId: string | null;
    note: string | null;
    at: Date;
  },
): Promise<ExtrasRequest | null> {
  const result = await db.query(
    `UPDATE booking.booking_change_requests r
     SET status=$4, decision_actor_user_id=$5::uuid, decision_note=$6, decided_at=$7, updated_at=$7
     FROM booking.guest_bookings b
     WHERE r.id=$3::uuid AND r.guest_booking_id=$2::uuid AND b.id=r.guest_booking_id
       AND b.property_id=$1::uuid AND r.request_type='addon_change' AND r.status='pending'
     RETURNING ${columns("r.")}`,
    [
      input.propertyId,
      input.guestBookingId,
      input.requestId,
      input.decision,
      input.actorUserId,
      input.note,
      input.at,
    ],
  );
  return serializeRequest(result.rows[0]);
}
