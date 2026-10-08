import { parseBookingPricingOfferTerms } from "@vayada/domain-booking/replacement-pricing";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  createPgTargetBookingAddonItemsRepository,
  type BookingAddonItemsPool,
} from "../routes/bookingAddonItems.js";
import {
  calculateManualBookingPreview,
  type ManualBookingPricingPublication,
} from "../routes/pmsManualBookingPreviewCalculation.js";
import type {
  PmsManualBookingCurrentPricingEvidence,
  PmsManualBookingTransaction,
  PmsManualBookingTransactionalPricingPort,
} from "./pmsManualBookingTransactionPorts.js";
import { createTargetPmsOperationsReadRepository } from "./pmsOperationsReadModel.js";
import { readCurrentPricingSnapshot } from "./replacementPricingSnapshot.js";

type Queryable = PmsManualBookingTransaction;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The property's active pricing-v2 publication for front-desk pricing, read without row locks.
 * The head names one revision; its rooms and the offer terms it references are immutable rows,
 * so separate READ COMMITTED statements stay consistent. Booking-engine authority and online
 * payment readiness do not gate a staff booking, and the route has already authorized the
 * property. An offer whose terms row is missing prices as rate_not_found. */
export async function readManualBookingPricingPublication(
  queryable: Queryable,
  propertyId: string,
): Promise<ManualBookingPricingPublication | null> {
  if (!UUID.test(propertyId)) return null;
  const id = propertyId.toLowerCase();
  const stored = await readCurrentPricingSnapshot(queryable as unknown as PoolClient, id);
  if (!stored) return null;
  const references = stored.rooms.flatMap((room) =>
    room.offers.map((offer) => [room.roomTypeId, offer.id, offer.termsRevision] as const),
  );
  const rows = (
    await queryable.query<{ terms: unknown }>(
      `SELECT terms.terms FROM booking.pricing_v2_offer_terms terms
       JOIN unnest($2::uuid[], $3::text[], $4::uuid[]) AS ref(room_type_id, offer_id, revision)
         ON ref.room_type_id = terms.room_type_id AND ref.offer_id = terms.offer_id
        AND ref.revision = terms.revision
       WHERE terms.property_id = $1::uuid`,
      [
        id,
        references.map((reference) => reference[0]),
        references.map((reference) => reference[1]),
        references.map((reference) => reference[2]),
      ],
    )
  ).rows;
  const terms = rows.flatMap((row) => parseBookingPricingOfferTerms(row.terms) ?? []);
  return {
    revision: stored.revision,
    currency: stored.currency,
    rooms: stored.rooms,
    terms,
  };
}

/** Property pricing currency for bookings priced only by custom rates. */
export async function readManualBookingPropertyCurrency(
  queryable: Queryable,
  propertyId: string,
): Promise<string | null> {
  if (!UUID.test(propertyId)) return null;
  const row = (
    await queryable.query<{ currency: string }>(
      "SELECT currency::text AS currency FROM pms.property_pricing_settings WHERE property_id = $1::uuid",
      [propertyId.toLowerCase()],
    )
  ).rows[0];
  return row?.currency ?? null;
}

/** Preview reads on the ordinary target login, straight from the pool: nothing is locked. */
export function createManualBookingPricingPublicationReader(pool: Pick<Pool, "query">) {
  return {
    readCurrentPricingPublication: ({ propertyId }: { propertyId: string }) =>
      readManualBookingPricingPublication(pool, propertyId),
    readPropertyPricingCurrency: (propertyId: string) =>
      readManualBookingPropertyCurrency(pool, propertyId),
  };
}

export function createPmsManualBookingCurrentPricingEvidence(): PmsManualBookingCurrentPricingEvidence {
  return {
    readCurrentPricingPublication: ({ transaction, propertyId }) =>
      readManualBookingPricingPublication(transaction, propertyId),
    readPropertyPricingCurrency: ({ transaction, propertyId }) =>
      readManualBookingPropertyCurrency(transaction, propertyId),
  };
}

export function createPmsManualBookingTransactionalPricingPort(
  current: PmsManualBookingCurrentPricingEvidence,
): PmsManualBookingTransactionalPricingPort {
  return {
    async calculate({ transaction, command }) {
      const pms = createTargetPmsOperationsReadRepository({
        connectionString: "caller-transaction",
        pool: transaction,
      });
      const addonRepository = createPgTargetBookingAddonItemsRepository({
        connectionString: "caller-transaction",
        pool: addonQueryable(transaction),
      });
      return calculateManualBookingPreview(
        { propertyId: command.propertyId, organizationId: command.organizationId },
        {
          contractVersion: command.contractVersion,
          stays: command.stays.map((stay) =>
            stay.childAgesAtCheckIn
              ? { ...stay, childAgesAtCheckIn: [...stay.childAgesAtCheckIn] }
              : { ...stay },
          ) as Parameters<typeof calculateManualBookingPreview>[1]["stays"],
          ...(command.expectedPricingRevision !== undefined
            ? { expectedPricingRevision: command.expectedPricingRevision }
            : {}),
          addOns: command.addOns.map((selection) => ({
            ...selection,
            serviceUnits: [...selection.serviceUnits],
          })),
        },
        {
          pms,
          publication: {
            readCurrentPricingPublication: ({ propertyId, organizationId }) =>
              current.readCurrentPricingPublication({ transaction, propertyId, organizationId }),
            readPropertyPricingCurrency: (propertyId) =>
              current.readPropertyPricingCurrency({ transaction, propertyId }),
          },
          booking: {
            listAddonItemsByHotelId: (propertyId) =>
              addonRepository.listAddonItemsByHotelId(propertyId),
          },
        },
      );
    },
  };
}

function addonQueryable(transaction: PmsManualBookingTransaction): BookingAddonItemsPool {
  return {
    query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      return transaction.query<Row>(text, values);
    },
  };
}
