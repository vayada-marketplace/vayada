import type { Pool } from "pg";
import { lockCurrentGuestChoiceRevision } from "./bookingGuestChoiceStore.js";

/** Internal owner evidence for authorized readiness/publication orchestration.
 * Scope comes from the orchestrator, never a public request body. No pricing fallback. */
export function createBookingGuestChoicePublicationReader(pool: Pool) {
  return {
    async getCurrentGuestRules(scope: { propertyId: string; organizationId: string }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = await lockCurrentGuestChoiceRevision(
          client,
          scope.propertyId,
          scope.organizationId,
        );
        if (!current) {
          await client.query("COMMIT");
          return null;
        }
        const row = (
          await client.query(
            "SELECT confirmed_at FROM booking.guest_choice_revisions WHERE property_id=$1 AND organization_id=$2 AND revision=$3",
            [
              scope.propertyId,
              scope.organizationId,
              current.sourceRevision.slice("guest-choices:".length),
            ],
          )
        ).rows[0];
        if (!(row?.confirmed_at instanceof Date)) throw new Error("invalid_guest_confirmation");
        await client.query("COMMIT");
        return {
          ...current,
          organizationId: scope.organizationId.toLowerCase(),
          confirmedAt: row.confirmed_at.toISOString(),
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
export type BookingGuestChoicePublicationReader = ReturnType<
  typeof createBookingGuestChoicePublicationReader
>;
