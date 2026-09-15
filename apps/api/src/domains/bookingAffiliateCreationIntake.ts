import type pg from "pg";
import { AFFILIATE_BOOKING_EVIDENCE_VERSION } from "@vayada/domain-booking";
import {
  ingestAffiliateEvidenceFromSource,
  lockCurrentHotelScope,
} from "./affiliateEvidenceIntake.js";
import { readBookingAffiliateCreationEvidence } from "./bookingAffiliateCreationEvidence.js";

/** Internal native source entry point. Caller must authorize the operation on every call.
 * No HTTP route/worker is enabled; creation provenance is not attribution or completion.
 */
export function ingestBookingAffiliateCreation(
  pool: pg.Pool,
  scope: { organizationId: string; propertyId: string; bookingId: string },
) {
  // Detach caller scope before asynchronous work; no caller-provided facts are consumed.
  const { organizationId, propertyId, bookingId } = scope;
  const binding = {
    organizationId,
    propertyId,
    externalPropertyId: propertyId,
    connectionId: `vayada-booking:${propertyId}`,
    state: "active" as const,
  };
  return ingestAffiliateEvidenceFromSource(pool, async (client) => {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bookingId) ||
      !(await lockCurrentHotelScope(client, binding))
    )
      return null;
    // FOR UPDATE also blocks new status-event inserts through their booking foreign key.
    const booking = await client.query(
      "SELECT id FROM booking.guest_bookings WHERE id=$1 AND property_id=$2 FOR UPDATE",
      [bookingId, propertyId],
    );
    if (!booking.rowCount) return null;
    await client.query(
      "SELECT id FROM booking.booking_status_events WHERE guest_booking_id=$1 ORDER BY id FOR SHARE",
      [bookingId],
    );
    const source = await readBookingAffiliateCreationEvidence(client, { propertyId, bookingId });
    if (source.status !== "recorded") return null;
    const evidenceReference = `booking-status-event:${source.creationEventId}`;
    return {
      authority: {
        binding,
        evidence: { ...binding, evidenceReference },
        mappingVersion: "vayada-creation.v1",
      },
      observation: {
        contractVersion: AFFILIATE_BOOKING_EVIDENCE_VERSION,
        sourceEventKey: `native-creation:${source.creationEventId}`,
        sourceRevision: null,
        supersedesEventKey: null,
        sourceOccurredAt: source.originalBookedAt,
        retrievedAt: null,
        booking: {
          externalPropertyId: propertyId,
          reservationId: bookingId,
          reservationItemId: null,
        },
        facts: {},
        provenance: {
          kind: "authenticated_source_event",
          evidenceReference,
          originActor: "unknown",
          causedByVayadaCommandId: null,
        },
      },
    };
  });
}
