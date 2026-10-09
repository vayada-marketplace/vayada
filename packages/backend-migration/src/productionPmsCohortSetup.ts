import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { bool, currency, iso, requiredText, uuid } from "./productionBookingValues.js";
import { outsideCohortSource } from "./productionMigrationCohort.js";
import { addPmsBlocker, safePmsSourceId } from "./productionPmsContext.js";
import type { PmsBuildContext, PmsTargetRecord } from "./productionPmsTypes.js";
import { pmsRecord } from "./productionPmsValues.js";

// VAY-1362 setup completeness (engineering/legacy-migration-cohort-scope.md): a carried cohort
// hotel leaves the import in the state native onboarding leaves a property in. Without a cohort
// nothing here plans or changes a row, so no-cohort plans and checksums are unchanged.

/** The native V1 pricing currencies (apps/api pmsPricingCurrencyCapabilities.ts). */
export const NATIVE_PRICING_CURRENCIES = new Set([
  "AED", "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP", "HKD", "HRK", "INR",
  "LKR", "MXN", "MYR", "NOK", "NZD", "PHP", "PLN", "RON", "RUB", "SEK", "SGD", "THB", "TRY", "USD",
]); // prettier-ignore

/** A cohort hotel the import makes operable: inside the cohort and not in private quarantine. */
export function carriedCohortHotel(context: PmsBuildContext, hotelId: string): boolean {
  return (
    !!context.cohort &&
    !outsideCohortSource(context.cohort, "pms", hotelId) &&
    !context.target.propertyLinks.some(
      (link) =>
        link.sourceId.toLowerCase() === hotelId &&
        link.migrationDisposition === "private_quarantine",
    )
  );
}

/**
 * Rooms whose legacy number becomes a verified operational label, as the native room writer
 * stores one (pmsPhysicalRoomManagementRepository: room_number plus 'verified'). Only operating
 * rooms of carried cohort hotels qualify, and only when no other operating room of the property
 * shares the label case-insensitively (uq_pms_rooms_property_verified_label_ci). Call after the
 * room-type dispositions have set the effective activity.
 */
export function verifiedCohortRoomIds(context: PmsBuildContext): Set<string> {
  const byLabel = new Map<string, string[]>();
  for (const room of context.rowsByTable.get("rooms") ?? [])
    try {
      const hotelId = uuid(room.data["hotel_id"], "hotel_id");
      const propertyId = context.propertyByHotel.get(hotelId);
      const parent = context.roomTypeById.get(uuid(room.data["room_type_id"], "room_type_id"));
      if (!propertyId || !parent || !carriedCohortHotel(context, hotelId)) continue;
      const parentId = uuid(parent.data["id"], "id");
      const operating =
        context.effectiveRoomTypeActiveById.get(parentId) ??
        bool(parent.data["is_active"], "is_active", true);
      const label = requiredText(room.data["room_number"], "room_number");
      if (!operating || label.length > 200) continue;
      const key = `${propertyId}:${label.toLowerCase()}`;
      byLabel.set(key, [...(byLabel.get(key) ?? []), uuid(room.data["id"], "id")]);
    } catch {
      // The room builder reports a malformed source row as a blocker.
    }
  return new Set([...byLabel.values()].flatMap((ids) => (ids.length === 1 ? ids : [])));
}

/**
 * pms.property_pricing_settings in the native first-currency shape (pmsPricingCommandRepository:
 * revision 1, created_at = updated_at, optional_pricing_aggregate_revision left to its default 0).
 * The currency is the one the property's operating room types (else all its room types) carry,
 * which legacy keeps equal to the Booking currency. An ambiguous or unsupported currency writes
 * no row, as the native command refuses it, so the property stays in setup.
 */
export function buildPmsPricingSettingsRecords(context: PmsBuildContext): PmsTargetRecord[] {
  if (!context.cohort) return [];
  const existing = new Map(
    context.target.records
      .filter((record) => record.targetTable === "property_pricing_settings")
      .map((record) => [record.targetId, record]),
  );
  const records: PmsTargetRecord[] = [];
  for (const hotel of context.rowsByTable.get("hotels") ?? [])
    try {
      const hotelId = uuid(hotel.data["id"], "id");
      const propertyId = context.propertyByHotel.get(hotelId);
      if (!propertyId || !carriedCohortHotel(context, hotelId)) continue;
      const pricingCurrency = propertyCurrency(context, hotelId);
      if (!pricingCurrency) continue;
      records.push(pricingRecord(context, hotel, propertyId, pricingCurrency, existing));
    } catch (error) {
      addPmsBlocker(
        context,
        "INVALID_SOURCE_ROW",
        "pms.hotels",
        safePmsSourceId(hotel),
        error instanceof Error ? error.message : "Invalid pricing currency source",
      );
    }
  return records;
}

function propertyCurrency(context: PmsBuildContext, hotelId: string): string | null {
  const roomTypes = (context.rowsByTable.get("room_types") ?? []).filter(
    (row) => String(row.data["hotel_id"] ?? "").toLowerCase() === hotelId,
  );
  const active = roomTypes.filter(
    (row) =>
      context.effectiveRoomTypeActiveById.get(uuid(row.data["id"], "id")) ??
      bool(row.data["is_active"], "is_active", true),
  );
  const currencies = new Set(
    (active.length ? active : roomTypes).map((row) => currency(row.data["currency"] ?? "EUR")),
  );
  const [only] = currencies;
  return currencies.size === 1 && NATIVE_PRICING_CURRENCIES.has(only!) ? only! : null;
}

function pricingRecord(
  context: PmsBuildContext,
  hotel: IdentitySourceRow,
  propertyId: string,
  pricingCurrency: string,
  existing: Map<string, PmsBuildContext["target"]["records"][number]>,
): PmsTargetRecord {
  const current = existing.get(propertyId);
  const migratedAt = new Date(context.completedAt).toISOString();
  const same = current?.row["currency"] === pricingCurrency;
  // As the native writer: revision 1 on create and +1 per currency change. An unchanged currency
  // keeps its revision and times, so reruns and the post-write verification plan nothing.
  const revision = current ? Number(current.row["pricingCurrencyRevision"]) + (same ? 0 : 1) : 1;
  return pmsRecord(
    hotel,
    "property_pricing_settings",
    propertyId,
    migratedAt,
    true,
    {
      propertyId,
      currency: pricingCurrency,
      pricingCurrencyRevision: revision,
      createdAt: current ? iso(current.row["createdAt"], "created_at") : migratedAt,
      updatedAt: (current && same && current.updatedAt) || migratedAt,
    },
    { id: hotel.data["id"], currency: pricingCurrency },
  );
}
