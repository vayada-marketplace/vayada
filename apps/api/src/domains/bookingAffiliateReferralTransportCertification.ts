import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { RequestContext } from "@vayada/backend-auth";
import { lockAffiliateValidationScope } from "./bookingAffiliateValidationProbe.js";

type Input = {
  context: RequestContext;
  propertyId: string;
  destinationVersionId: string;
  probe: string;
};

/** Server-owned verifier configuration. None of these values may come from browser input. */
export type AffiliateReferralTransportCertificationVerifier = {
  environment: "local" | "sandbox";
  connectionReference: string;
  adapterVersion: string;
  evidenceReferences: readonly string[];
};

type Result =
  | {
      ok: true;
      certificationId: string;
      bookingId: string;
      completedAt: string;
      replayed: boolean;
    }
  | {
      ok: false;
      code:
        | "invalid_request"
        | "scope_unavailable"
        | "probe_unavailable"
        | "transport_unavailable"
        | "certification_conflict";
    };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max;

function validEvidenceReferences(value: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 100 &&
    value.every((reference) => bounded(reference, 256)) &&
    Buffer.byteLength(JSON.stringify(value), "utf8") <= 32_768
  );
}

const isFinalProbeUnavailable = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "23514" &&
  "message" in error &&
  error.message === "Affiliate referral transport certification scope is unavailable";

/** Internal diagnostic command. It creates no production readiness or earning evidence. */
export async function certifyAffiliateReferralTransport(
  pool: pg.Pool,
  input: Input,
  verifier: AffiliateReferralTransportCertificationVerifier,
): Promise<Result> {
  if (
    !uuid.test(input.propertyId) ||
    !uuid.test(input.destinationVersionId) ||
    typeof input.probe !== "string" ||
    !input.probe.startsWith("avp_") ||
    !uuid.test(input.probe.slice(4)) ||
    !bounded(input.context.audit.requestId, 200) ||
    !["local", "sandbox"].includes(verifier.environment) ||
    !bounded(verifier.connectionReference, 200) ||
    !bounded(verifier.adapterVersion, 100) ||
    !validEvidenceReferences(verifier.evidenceReferences)
  )
    return { ok: false, code: "invalid_request" };

  const propertyId = input.propertyId.toLowerCase();
  const destinationVersionId = input.destinationVersionId.toLowerCase();
  const probeId = input.probe.slice(4).toLowerCase();
  const organizationId = input.context.selectedOrganization.organizationId;
  const actorId = input.context.actor.internalUserId;
  const evidenceReferences = [...verifier.evidenceReferences];
  const client = await pool.connect();
  const fail = async (code: Exclude<Result, { ok: true }>["code"]): Promise<Result> => {
    await client.query("ROLLBACK");
    return { ok: false, code };
  };

  try {
    await client.query("BEGIN");
    if (
      !(await lockAffiliateValidationScope(client, input.context, propertyId, destinationVersionId))
    )
      return await fail("scope_unavailable");

    const probe = (
      await client.query(
        `SELECT id FROM booking.affiliate_validation_probes
        WHERE id=$1 AND property_id=$2 AND destination_version_id=$3 AND organization_id=$4
          AND purpose='validation' AND environment=$5 AND connection_reference=$6
          AND adapter_version=$7
        FOR UPDATE`,
        [
          probeId,
          propertyId,
          destinationVersionId,
          organizationId,
          verifier.environment,
          verifier.connectionReference,
          verifier.adapterVersion,
        ],
      )
    ).rows[0];
    if (!probe) return await fail("probe_unavailable");
    const currentProbe = (
      await client.query(
        `SELECT probe.expires_at > clock_timestamp() AS unexpired,
          NOT EXISTS (
            SELECT 1 FROM booking.affiliate_validation_probe_revocations revoked
            WHERE revoked.probe_id=probe.id
          ) AS unrevoked
        FROM booking.affiliate_validation_probes probe WHERE probe.id=$1`,
        [probeId],
      )
    ).rows[0];
    if (!currentProbe?.unexpired || !currentProbe.unrevoked) return await fail("probe_unavailable");

    const transport = (
      await client.query(
        `SELECT binding.booking_id
        FROM booking.affiliate_validation_booking_bindings binding
        JOIN booking.guest_bookings guest ON guest.id=binding.booking_id
          AND guest.property_id=binding.property_id
        WHERE binding.probe_id=$1 AND binding.property_id=$2
          AND guest.lifecycle_status='draft' AND guest.total_amount=0 AND guest.balance_amount=0
          AND guest.booking_metadata->>'isTestBooking'='true'
          AND guest.booking_metadata->>'purpose'='affiliate_validation'
          AND NOT EXISTS (
            SELECT 1 FROM finance.affiliate_earning_journal earning
            WHERE earning.property_id=binding.property_id
              AND booking.try_affiliate_booking_uuid(earning.booking_id)=binding.booking_id
          )
          AND 1=(
            SELECT count(*) FROM booking.affiliate_validation_booking_bindings exact_binding
            WHERE exact_binding.probe_id=binding.probe_id
          )
        FOR UPDATE OF guest`,
        [probeId, propertyId],
      )
    ).rows[0];
    if (!transport) return await fail("transport_unavailable");

    const prior = (
      await client.query(
        `SELECT id,booking_id,evidence_references,completed_at
        FROM booking.affiliate_referral_transport_certifications
        WHERE probe_id=$1 AND capability='referral_round_trip'
          AND validation_kind='adapter_certification'`,
        [probeId],
      )
    ).rows[0];
    if (prior) {
      if (
        prior.booking_id !== transport.booking_id ||
        JSON.stringify(prior.evidence_references) !== JSON.stringify(evidenceReferences)
      )
        return await fail("certification_conflict");
      await client.query("COMMIT");
      return {
        ok: true,
        certificationId: prior.id,
        bookingId: prior.booking_id,
        completedAt: prior.completed_at.toISOString(),
        replayed: true,
      };
    }

    const inserted = (
      await client.query(
        `INSERT INTO booking.affiliate_referral_transport_certifications
        (id,probe_id,booking_id,property_id,destination_version_id,organization_id,environment,
         connection_reference,adapter_version,contract_version,evidence_references,actor_id,
         request_id,completed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,
          'booking-affiliate-referral-transport-certification.v1',$10,$11,$12,'infinity')
        RETURNING id,booking_id,completed_at`,
        [
          randomUUID(),
          probeId,
          transport.booking_id,
          propertyId,
          destinationVersionId,
          organizationId,
          verifier.environment,
          verifier.connectionReference,
          verifier.adapterVersion,
          JSON.stringify(evidenceReferences),
          actorId,
          input.context.audit.requestId,
        ],
      )
    ).rows[0];
    await client.query("COMMIT");
    return {
      ok: true,
      certificationId: inserted.id,
      bookingId: inserted.booking_id,
      completedAt: inserted.completed_at.toISOString(),
      replayed: false,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (isFinalProbeUnavailable(error)) return { ok: false, code: "probe_unavailable" };
    throw error;
  } finally {
    client.release();
  }
}
