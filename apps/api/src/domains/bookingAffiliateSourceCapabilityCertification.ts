import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { RequestContext } from "@vayada/backend-auth";
import {
  affiliateSourceCapabilities,
  type AffiliateSourceCapability,
} from "./bookingAffiliateSourceCapabilityProductionPreflight.js";
import { lockAffiliateValidationScope } from "./bookingAffiliateValidationProbe.js";

type Input = {
  context: RequestContext;
  propertyId: string;
  destinationVersionId: string;
  probe: string;
  capability: AffiliateSourceCapability;
};

type VerificationInput = {
  propertyId: string;
  destinationVersionId: string;
  probeId: string;
  bookingId: string;
  capability: AffiliateSourceCapability;
  signal: AbortSignal;
};

type VerificationResult =
  | {
      ok: true;
      connectionReference: string;
      adapterVersion: string;
      verifiedCapability: AffiliateSourceCapability;
      verifiedBookingId: string;
      evidenceReferences: readonly string[];
    }
  | { ok: false; code: "fixture_unavailable" | "capability_unavailable" };

/** Server-owned isolated-environment adapter certification port. */
export type AffiliateSourceCapabilityCertificationVerifier = {
  environment: "local" | "sandbox";
  connectionReference: string;
  adapterVersion: string;
  timeoutMilliseconds: number;
  /**
   * Read-only diagnostic inspection. It must not mutate provider state and may
   * be retried after timeout; implementations should stop promptly on abort.
   */
  verifySyntheticCapability(input: VerificationInput): Promise<VerificationResult>;
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
        | "fixture_unavailable"
        | "verification_unavailable"
        | "evidence_conflict";
    };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max;
const assertions: Record<AffiliateSourceCapability, string> = {
  reservation_lifecycle: "synthetic_reservation_lifecycle_observed",
  stay_completion: "synthetic_stay_completion_observed",
  accommodation_revenue: "synthetic_accommodation_revenue_observed",
};

function validEvidenceReferences(value: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 100 &&
    value.every((reference) => bounded(reference, 256)) &&
    Buffer.byteLength(JSON.stringify(value), "utf8") <= 32_768
  );
}

async function verifyWithTimeout(
  verify: AffiliateSourceCapabilityCertificationVerifier["verifySyntheticCapability"],
  timeoutMilliseconds: number,
  input: Omit<VerificationInput, "signal">,
): Promise<VerificationResult | undefined> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      verify({ ...input, signal: controller.signal }),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          resolve(undefined);
          setTimeout(() => controller.abort(), 0);
        }, timeoutMilliseconds);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const isFinalProbeUnavailable = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "23514" &&
  "message" in error &&
  error.message === "Affiliate source capability certification scope is unavailable";

/**
 * Certifies one capability against an isolated synthetic booking. It creates no
 * production evidence, attribution, payment or earning data and never grants readiness.
 */
export async function certifyAffiliateSourceCapability(
  pool: pg.Pool,
  input: Input,
  verifier: AffiliateSourceCapabilityCertificationVerifier,
): Promise<Result> {
  const environment = verifier.environment;
  const connectionReference = verifier.connectionReference;
  const adapterVersion = verifier.adapterVersion;
  const timeoutMilliseconds = verifier.timeoutMilliseconds;
  const verifySyntheticCapability = verifier.verifySyntheticCapability.bind(verifier);
  if (
    !uuid.test(input.propertyId) ||
    !uuid.test(input.destinationVersionId) ||
    typeof input.probe !== "string" ||
    !input.probe.startsWith("avp_") ||
    !uuid.test(input.probe.slice(4)) ||
    !affiliateSourceCapabilities.includes(input.capability) ||
    !bounded(input.context.audit.requestId, 200) ||
    !["local", "sandbox"].includes(environment) ||
    !bounded(connectionReference, 200) ||
    !bounded(adapterVersion, 100) ||
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > 30_000
  )
    return { ok: false, code: "invalid_request" };

  const propertyId = input.propertyId.toLowerCase();
  const destinationVersionId = input.destinationVersionId.toLowerCase();
  const probeId = input.probe.slice(4).toLowerCase();
  const organizationId = input.context.selectedOrganization.organizationId;
  const actorId = input.context.actor.internalUserId;
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
        `SELECT probe.id,probe.expires_at > clock_timestamp() AS unexpired,
          NOT EXISTS (
            SELECT 1 FROM booking.affiliate_validation_probe_revocations revoked
            WHERE revoked.probe_id=probe.id
          ) AS unrevoked
        FROM booking.affiliate_validation_probes probe
        WHERE probe.id=$1 AND probe.property_id=$2 AND probe.destination_version_id=$3
          AND probe.organization_id=$4 AND probe.purpose='validation' AND probe.environment=$5
          AND probe.connection_reference=$6 AND probe.adapter_version=$7
        FOR UPDATE OF probe`,
        [
          probeId,
          propertyId,
          destinationVersionId,
          organizationId,
          environment,
          connectionReference,
          adapterVersion,
        ],
      )
    ).rows[0];
    if (!probe?.unexpired || !probe.unrevoked) return await fail("probe_unavailable");

    const fixture = (
      await client.query(
        `SELECT binding.booking_id
        FROM booking.affiliate_validation_booking_bindings binding
        JOIN booking.guest_bookings guest ON guest.id=binding.booking_id
          AND guest.property_id=binding.property_id
        WHERE binding.probe_id=$1 AND binding.property_id=$2
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
    if (!fixture) return await fail("fixture_unavailable");

    const prior = (
      await client.query(
        `SELECT id,booking_id,completed_at
        FROM booking.affiliate_source_capability_certifications
        WHERE probe_id=$1 AND capability=$2`,
        [probeId, input.capability],
      )
    ).rows[0];
    if (prior) {
      await client.query("COMMIT");
      return {
        ok: true,
        certificationId: prior.id,
        bookingId: prior.booking_id,
        completedAt: prior.completed_at.toISOString(),
        replayed: true,
      };
    }

    const verified = await verifyWithTimeout(verifySyntheticCapability, timeoutMilliseconds, {
      propertyId,
      destinationVersionId,
      probeId,
      bookingId: fixture.booking_id,
      capability: input.capability,
    });
    if (!verified?.ok) return await fail("verification_unavailable");
    if (
      verified.connectionReference !== connectionReference ||
      verified.adapterVersion !== adapterVersion ||
      verified.verifiedCapability !== input.capability ||
      verified.verifiedBookingId !== fixture.booking_id ||
      !validEvidenceReferences(verified.evidenceReferences)
    )
      return await fail("evidence_conflict");

    const inserted = (
      await client.query(
        `INSERT INTO booking.affiliate_source_capability_certifications
        (id,probe_id,booking_id,property_id,destination_version_id,organization_id,environment,
         connection_reference,adapter_version,capability,validation_kind,evidence_scope,
         validation_method,assertion,contract_version,evidence_references,actor_id,request_id,
         completed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'adapter_certification',
          'capability_validation','isolated_synthetic_fixture',$11,
          'booking-affiliate-source-capability-certification.v1',$12,$13,$14,'infinity')
        RETURNING id,booking_id,completed_at`,
        [
          randomUUID(),
          probeId,
          fixture.booking_id,
          propertyId,
          destinationVersionId,
          organizationId,
          environment,
          connectionReference,
          adapterVersion,
          input.capability,
          assertions[input.capability],
          JSON.stringify([...verified.evidenceReferences]),
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
