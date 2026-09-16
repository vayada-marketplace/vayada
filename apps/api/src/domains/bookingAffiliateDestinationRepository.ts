import pg from "pg";
import {
  assessAffiliateDestinationTracking,
  parseAffiliateBookingDestinationConfiguration,
} from "@vayada/domain-booking";
import { saveBookingAffiliateDestinationFromMarketplace as save } from "./bookingAffiliateDestinationSave.js";

export async function readBookingAffiliateDestinations(
  database: Pick<pg.Pool, "query">,
  propertyId: string,
  organizationId: string,
  versionId?: string,
) {
  if (
    versionId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(versionId)
  )
    return [];
  const result = await database.query(
    `SELECT d.id AS "destinationVersionId", d.display_name, d.booking_url, d.recorded_at AS "createdAt"
       FROM booking.affiliate_destination_versions d
       JOIN hotel_catalog.properties p ON p.id=d.property_id AND p.profile_status <> 'disabled'
       WHERE d.property_id=$1 AND d.created_by_organization_id=$2 AND ($3::uuid IS NULL OR d.id=$3)
       ORDER BY d.recorded_at DESC,d.id DESC LIMIT 20`,
    [propertyId, organizationId, versionId ?? null],
  );
  return result.rows.map((row) => {
    const configuration = parseAffiliateBookingDestinationConfiguration({
      displayName: row.display_name,
      bookingUrl: row.booking_url,
    });
    if (!configuration) throw new Error("Stored affiliate destination is invalid");
    return {
      destinationVersionId: row.destinationVersionId as string,
      configuration,
      createdAt: row.createdAt as Date,
      trackingStatus: "not_validated" as const,
      // No trusted affiliate evidence adapter is wired yet. Configuration cannot supply proof.
      trackingReadiness: assessAffiliateDestinationTracking(
        { destinationVersionId: row.destinationVersionId, propertyId, enabled: true },
        [],
      ),
    };
  });
}

export function createPgBookingAffiliateDestinationRepository(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 3 });
  return {
    save: (input: Parameters<typeof save>[1]) => save(pool, input),
    list: async (propertyId: string, organizationId: string) => ({
      destinations: await readBookingAffiliateDestinations(pool, propertyId, organizationId),
    }),
    async get(propertyId: string, organizationId: string, versionId: string) {
      const rows = await readBookingAffiliateDestinations(
        pool,
        propertyId,
        organizationId,
        versionId,
      );
      return rows.length ? rows[0]! : null;
    },
    close: () => pool.end(),
  };
}
export type AffiliateDestinationRepository = ReturnType<
  typeof createPgBookingAffiliateDestinationRepository
>;
