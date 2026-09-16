import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { RequestContext } from "@vayada/backend-auth";
import { lockAffiliateValidationScope } from "./bookingAffiliateValidationProbe.js";

type Input = {
  context: RequestContext;
  propertyId: string;
  destinationVersionId: string;
  idempotencyKey: string;
};

type VerificationInput = {
  propertyId: string;
  destinationVersionId: string;
  correlationReference: string;
  signal: AbortSignal;
};

type VerificationResult =
  | {
      ok: true;
      connectionReference: string;
      adapterVersion: string;
      returnedCorrelationReference: string;
      evidenceReferences: readonly string[];
    }
  | { ok: false; code: "connection_unavailable" | "capability_unavailable" };

/** Server-owned adapter configuration and non-mutating provider port. */
export type AffiliateReferralProductionPreflightVerifier = {
  connectionReference: string;
  adapterVersion: string;
  timeoutMilliseconds: number;
  verifyNonMutatingReferralRoundTrip(input: VerificationInput): Promise<VerificationResult>;
};

type Result =
  | {
      ok: true;
      preflightId: string;
      completedAt: string;
      replayed: boolean;
    }
  | {
      ok: false;
      code:
        | "invalid_request"
        | "scope_unavailable"
        | "idempotency_conflict"
        | "verification_unavailable"
        | "evidence_conflict";
    };

const operation = "booking.affiliate-referral-production-preflight.v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

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
  verify: AffiliateReferralProductionPreflightVerifier["verifyNonMutatingReferralRoundTrip"],
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
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Internal production capability check. The verifier must use a documented non-mutating
 * provider mechanism. This command creates no reservation, inventory, payment, attribution
 * or earning data and its evidence alone never grants publication readiness.
 */
export async function verifyAffiliateReferralProductionPreflight(
  pool: pg.Pool,
  input: Input,
  verifier: AffiliateReferralProductionPreflightVerifier,
): Promise<Result> {
  const connectionReference = verifier.connectionReference;
  const adapterVersion = verifier.adapterVersion;
  const timeoutMilliseconds = verifier.timeoutMilliseconds;
  const verifyNonMutatingReferralRoundTrip =
    verifier.verifyNonMutatingReferralRoundTrip.bind(verifier);
  if (
    !uuid.test(input.propertyId) ||
    !uuid.test(input.destinationVersionId) ||
    !bounded(input.idempotencyKey, 200) ||
    !bounded(input.context.audit.requestId, 200) ||
    !bounded(connectionReference, 200) ||
    !bounded(adapterVersion, 100) ||
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > 30_000
  )
    return { ok: false, code: "invalid_request" };

  const propertyId = input.propertyId.toLowerCase();
  const destinationVersionId = input.destinationVersionId.toLowerCase();
  const organizationId = input.context.selectedOrganization.organizationId;
  const actorId = input.context.actor.internalUserId;
  const commandKeyHash = hash(JSON.stringify([organizationId, input.idempotencyKey]));
  const requestFingerprintHash = hash(
    JSON.stringify([
      actorId,
      organizationId,
      propertyId,
      destinationVersionId,
      connectionReference,
      adapterVersion,
      "referral_round_trip",
    ]),
  );
  const client = await pool.connect();
  const fail = async (code: Exclude<Result, { ok: true }>["code"]): Promise<Result> => {
    await client.query("ROLLBACK");
    return { ok: false, code };
  };

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${operation}|${propertyId}|${commandKeyHash}`,
    ]);
    if (
      !(await lockAffiliateValidationScope(client, input.context, propertyId, destinationVersionId))
    )
      return await fail("scope_unavailable");

    const prior = (
      await client.query(
        `SELECT id,request_fingerprint_hash,completed_at
        FROM booking.affiliate_referral_production_preflights
        WHERE property_id=$1 AND command_key_hash=$2`,
        [propertyId, commandKeyHash],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_fingerprint_hash !== requestFingerprintHash)
        return await fail("idempotency_conflict");
      await client.query("COMMIT");
      return {
        ok: true,
        preflightId: prior.id,
        completedAt: prior.completed_at.toISOString(),
        replayed: true,
      };
    }

    const correlationReference = `arp_${randomUUID()}`;
    const verified = await verifyWithTimeout(
      verifyNonMutatingReferralRoundTrip,
      timeoutMilliseconds,
      { propertyId, destinationVersionId, correlationReference },
    );
    if (!verified?.ok) return await fail("verification_unavailable");
    if (
      verified.connectionReference !== connectionReference ||
      verified.adapterVersion !== adapterVersion ||
      verified.returnedCorrelationReference !== correlationReference ||
      !validEvidenceReferences(verified.evidenceReferences)
    )
      return await fail("evidence_conflict");

    const inserted = (
      await client.query(
        `INSERT INTO booking.affiliate_referral_production_preflights
        (id,property_id,destination_version_id,organization_id,environment,connection_reference,
         adapter_version,capability,validation_kind,evidence_scope,preflight_method,assertion,
         correlation_hash,contract_version,evidence_references,actor_id,request_id,completed_at,
         command_key_hash,request_fingerprint_hash)
        VALUES($1,$2,$3,$4,'production',$5,$6,'referral_round_trip','production_preflight',
          'capability_validation','documented_non_mutating_round_trip',
          'opaque_correlation_returned_without_booking',$7,
          'booking-affiliate-referral-production-preflight.v1',$8,$9,$10,'infinity',$11,$12)
        RETURNING id,completed_at`,
        [
          randomUUID(),
          propertyId,
          destinationVersionId,
          organizationId,
          connectionReference,
          adapterVersion,
          hash(correlationReference),
          JSON.stringify([...verified.evidenceReferences]),
          actorId,
          input.context.audit.requestId,
          commandKeyHash,
          requestFingerprintHash,
        ],
      )
    ).rows[0];
    await client.query("COMMIT");
    return {
      ok: true,
      preflightId: inserted.id,
      completedAt: inserted.completed_at.toISOString(),
      replayed: false,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
