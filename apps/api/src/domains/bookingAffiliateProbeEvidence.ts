import type pg from "pg";
import {
  readBookingAffiliateCreationEvidence,
  type BookingAffiliateCreationEvidence,
} from "./bookingAffiliateCreationEvidence.js";
import {
  resolveCheckoutValidationProbe,
  type AffiliateProbeCheckout,
} from "./bookingAffiliateProbeBinding.js";

type Result =
  | Exclude<BookingAffiliateCreationEvidence, { status: "recorded" }>
  | { status: "pending"; reason: "probe_binding_missing" }
  | { status: "needs_review"; reason: "conflicting_probe_binding" }
  | (Extract<BookingAffiliateCreationEvidence, { status: "recorded" }> & {
      purpose: "validation";
      probeId: string;
      destinationVersionId: string;
      environment: "local" | "sandbox";
      connectionReference: string;
      adapterVersion: string;
      bindingRecordedAt: string;
    });

/** Internal diagnostic read with fresh hotel authorization before any booking lookup.
 * A recorded result proves an original native booking/probe binding only: it is not
 * browser transport, live attribution, capability readiness, completion or revenue.
 * Configuration and clock are server-owned; no public route or Finance integration.
 */
export async function readBookingAffiliateProbeEvidence(
  pool: pg.Pool,
  input: { propertyId: string; bookingId: string },
  config: AffiliateProbeCheckout,
  now = new Date(),
): Promise<Result> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (![input.propertyId, input.bookingId].every((id) => typeof id === "string" && uuid.test(id)))
    return { status: "pending", reason: "scope_unavailable" };
  const propertyId = input.propertyId.toLowerCase(),
    bookingId = input.bookingId.toLowerCase();
  const client = await pool.connect();
  try {
    // READ COMMITTED sees revocations committed while waiting for the property lock.
    // That lock also serializes binding insertion; immutable bindings cannot change
    // between the single-query creation read and the binding lookup below.
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const probeId = await resolveCheckoutValidationProbe(client, propertyId, config);
    const creation = await readBookingAffiliateCreationEvidence(
      client,
      { propertyId, bookingId },
      now,
    );
    let result: Result =
      creation.status === "recorded"
        ? { status: "pending", reason: "probe_binding_missing" }
        : creation;
    if (creation.status === "recorded") {
      const binding = (
        await client.query(
          `SELECT request_id,recorded_at FROM booking.affiliate_validation_booking_bindings
         WHERE booking_id=$1 AND property_id=$2 AND probe_id=$3`,
          [bookingId, propertyId, probeId],
        )
      ).rows[0];
      if (binding) {
        result =
          binding.request_id !== creation.requestId
            ? { status: "needs_review", reason: "conflicting_probe_binding" }
            : {
                ...creation,
                purpose: "validation",
                probeId,
                destinationVersionId: config.destinationVersionId.toLowerCase(),
                environment: config.environment,
                connectionReference: config.connectionReference,
                adapterVersion: config.adapterVersion,
                bindingRecordedAt: binding.recorded_at.toISOString(),
              };
      }
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
