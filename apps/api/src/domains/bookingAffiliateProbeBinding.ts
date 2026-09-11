import type pg from "pg";
import type { RequestContext } from "@vayada/backend-auth";
import { lockAffiliateValidationScope } from "./bookingAffiliateValidationProbe.js";

/** Server-only, dedicated isolated validation adapter configuration. Never request data. */
export type AffiliateProbeCheckout = {
  freshContext: () => Promise<RequestContext>;
  probe: string;
  destinationVersionId: string;
  environment: "local" | "sandbox";
  connectionReference: string;
  adapterVersion: string;
};

/** Locks authority through the caller's checkout transaction, including replay. */
export async function resolveCheckoutValidationProbe(
  client: pg.PoolClient,
  propertyId: string,
  config: AffiliateProbeCheckout,
): Promise<string> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !["local", "sandbox"].includes(config.environment) ||
    typeof config.probe !== "string" ||
    !config.probe.startsWith("avp_") ||
    !uuid.test(config.probe.slice(4)) ||
    !uuid.test(config.destinationVersionId)
  )
    throw new Error("Validation probe configuration is invalid");
  const context = await config.freshContext();
  if (
    !(await lockAffiliateValidationScope(
      client,
      context,
      propertyId,
      config.destinationVersionId.toLowerCase(),
    ))
  )
    throw new Error("Validation probe scope is unavailable");
  const result = await client.query(
    `SELECT p.id FROM booking.affiliate_validation_probes p
    WHERE p.id=$1 AND p.property_id=$2 AND p.destination_version_id=$3 AND p.organization_id=$4
    AND p.purpose='validation' AND p.environment=$5 AND p.connection_reference=$6 AND p.adapter_version=$7
    AND p.expires_at > clock_timestamp()
    AND NOT EXISTS(SELECT 1 FROM booking.affiliate_validation_probe_revocations r WHERE r.probe_id=p.id)`,
    [
      config.probe.slice(4),
      propertyId,
      config.destinationVersionId,
      context.selectedOrganization.organizationId,
      config.environment,
      config.connectionReference,
      config.adapterVersion,
    ],
  );
  if (!result.rows.length) throw new Error("Validation probe is unavailable");
  return result.rows[0].id;
}

export async function bindCheckoutValidationProbe(
  client: pg.PoolClient,
  propertyId: string,
  bookingId: string,
  probeId: string,
  requestId: string,
): Promise<void> {
  // Recheck expiry immediately before binding. Revocation/ownership changes serialize
  // on the property lock acquired above; a failed insert rolls back the entire checkout.
  const result = await client.query(
    `INSERT INTO booking.affiliate_validation_booking_bindings(booking_id,property_id,probe_id,request_id)
    SELECT $1,$2,p.id,$4 FROM booking.affiliate_validation_probes p
    WHERE p.id=$3 AND p.property_id=$2 AND p.expires_at > clock_timestamp()
    AND NOT EXISTS(SELECT 1 FROM booking.affiliate_validation_probe_revocations r WHERE r.probe_id=p.id)
    RETURNING booking_id`,
    [bookingId, propertyId, probeId, requestId],
  );
  if (!result.rowCount) throw new Error("Validation probe expired before booking creation");
}
