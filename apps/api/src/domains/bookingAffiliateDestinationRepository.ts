import pg from "pg";
import {
  assessAffiliateDestinationTracking,
  parseAffiliateBookingDestinationConfiguration,
} from "@vayada/domain-booking";
import { saveBookingAffiliateDestinationFromMarketplace as save } from "./bookingAffiliateDestinationSave.js";
import {
  isVerifiedAffiliateDestinationTrackingReadiness,
  readAffiliateDestinationTrackingReadiness,
  type AffiliateDestinationTrackingConfigurationPort,
  type AffiliateDestinationTrackingReadinessPort,
} from "./bookingAffiliateDestinationTrackingReadiness.js";

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
       ORDER BY d.recorded_at DESC,d.id DESC LIMIT 20 FOR SHARE OF d,p`,
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

export function createPgBookingAffiliateDestinationRepository(
  connectionString: string,
  tracking?: {
    configuration: AffiliateDestinationTrackingConfigurationPort;
    readiness?: AffiliateDestinationTrackingReadinessPort;
  },
) {
  const pool = new pg.Pool({ connectionString, max: 3 });
  const read = async (propertyId: string, organizationId: string, versionId?: string) => {
    if (!tracking)
      return readBookingAffiliateDestinations(pool, propertyId, organizationId, versionId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const destinations = await readBookingAffiliateDestinations(
        client,
        propertyId,
        organizationId,
        versionId,
      );
      const results = [];
      for (const destination of destinations) {
        const scope = {
          propertyId,
          destinationVersionId: destination.destinationVersionId,
          organizationId,
        };
        const configuration = await tracking.configuration(client, scope);
        if (!configuration) {
          results.push(destination);
          continue;
        }
        const trackingReadiness = await (
          tracking.readiness ?? readAffiliateDestinationTrackingReadiness
        )(client, { ...scope, ...configuration });
        if (!isVerifiedAffiliateDestinationTrackingReadiness(trackingReadiness)) {
          results.push(destination);
          continue;
        }
        results.push({
          ...destination,
          trackingStatus: "validated" as const,
          trackingReadiness,
        });
      }
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  return {
    save: (input: Parameters<typeof save>[1]) => save(pool, input),
    list: async (propertyId: string, organizationId: string) => ({
      destinations: await read(propertyId, organizationId),
    }),
    async get(propertyId: string, organizationId: string, versionId: string) {
      const rows = await read(propertyId, organizationId, versionId);
      return rows.length ? rows[0]! : null;
    },
    close: () => pool.end(),
  };
}
export type AffiliateDestinationRepository = ReturnType<
  typeof createPgBookingAffiliateDestinationRepository
>;
