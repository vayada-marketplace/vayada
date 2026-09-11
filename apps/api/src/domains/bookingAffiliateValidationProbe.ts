import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { RequestContext } from "@vayada/backend-auth";
import { requireActiveEntitlement, requireResourceAccess } from "@vayada/backend-authorization";

type Deployment = {
  environment: "local" | "sandbox";
  connectionReference: string;
  adapterVersion: string;
};
type Input = { context: RequestContext; propertyId: string; destinationVersionId: string } & (
  | { action: "create"; idempotencyKey: string; lifetimeSeconds: number }
  | { action: "resolve" | "revoke"; probe: string }
);
type Result =
  | { ok: true; purpose: "validation"; probe: string; expiresAt: string; replayed: boolean }
  | { ok: true; revoked: true }
  | {
      ok: false;
      code: "invalid_request" | "scope_unavailable" | "idempotency_conflict" | "probe_unavailable";
    };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && !!value.trim() && value.length <= max;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Internal non-earning command. Every call needs fresh trusted auth context and
 * server-owned deployment identity. Never expose deployment as request fields.
 * No network access, redirect, click capture, capability verification or Finance call.
 */
export async function manageAffiliateValidationProbe(
  pool: pg.Pool,
  input: Input,
  deployment: Deployment,
): Promise<Result> {
  const { context } = input;
  if (
    ![input.propertyId, input.destinationVersionId].every(
      (v) => typeof v === "string" && uuid.test(v),
    ) ||
    !bounded(context.audit.requestId, 200) ||
    !["local", "sandbox"].includes(deployment.environment) ||
    !bounded(deployment.connectionReference, 200) ||
    !bounded(deployment.adapterVersion, 100) ||
    !["create", "resolve", "revoke"].includes(input.action)
  )
    return { ok: false, code: "invalid_request" };
  if (
    input.action === "create"
      ? !bounded(input.idempotencyKey, 200) ||
        !Number.isSafeInteger(input.lifetimeSeconds) ||
        input.lifetimeSeconds < 1 ||
        input.lifetimeSeconds > 86400
      : typeof input.probe !== "string" ||
        !input.probe.startsWith("avp_") ||
        !uuid.test(input.probe.slice(4))
  )
    return { ok: false, code: "invalid_request" };
  const propertyId = input.propertyId.toLowerCase(),
    destinationId = input.destinationVersionId.toLowerCase();
  const organizationId = context.selectedOrganization.organizationId,
    actorId = context.actor.internalUserId;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await lockAffiliateValidationScope(client, context, propertyId, destinationId))) {
      await client.query("ROLLBACK");
      return { ok: false, code: "scope_unavailable" };
    }
    let probeId: string,
      replayed = false;
    if (input.action === "create") {
      const key = hash(input.idempotencyKey);
      const fingerprint = hash(
        JSON.stringify([
          actorId,
          organizationId,
          propertyId,
          destinationId,
          input.lifetimeSeconds,
          deployment.environment,
          deployment.connectionReference,
          deployment.adapterVersion,
        ]),
      );
      const prior = (
        await client.query(
          `SELECT id,fingerprint FROM booking.affiliate_validation_probes WHERE property_id=$1 AND key_hash=$2`,
          [propertyId, key],
        )
      ).rows[0];
      if (prior && prior.fingerprint !== fingerprint) {
        await client.query("ROLLBACK");
        return { ok: false, code: "idempotency_conflict" };
      }
      replayed = !!prior;
      probeId = prior?.id ?? randomUUID();
      if (!prior)
        await client.query(
          `INSERT INTO booking.affiliate_validation_probes
        (id,property_id,destination_version_id,organization_id,actor_id,environment,connection_reference,adapter_version,request_id,key_hash,fingerprint,recorded_at,expires_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,t,t+make_interval(secs => $12) FROM (SELECT clock_timestamp() AS t) clock`,
          [
            probeId,
            propertyId,
            destinationId,
            organizationId,
            actorId,
            deployment.environment,
            deployment.connectionReference,
            deployment.adapterVersion,
            context.audit.requestId,
            key,
            fingerprint,
            input.lifetimeSeconds,
          ],
        );
    } else probeId = input.probe.slice(4).toLowerCase();
    const row = (
      await client.query(
        `SELECT p.*,r.probe_id IS NOT NULL AS revoked,p.expires_at > clock_timestamp() AS unexpired
      FROM booking.affiliate_validation_probes p LEFT JOIN booking.affiliate_validation_probe_revocations r ON r.probe_id=p.id
      WHERE p.id=$1 AND p.property_id=$2 AND p.destination_version_id=$3 AND p.organization_id=$4`,
        [probeId, propertyId, destinationId, organizationId],
      )
    ).rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, code: "probe_unavailable" };
    }
    if (input.action === "revoke") {
      await client.query(
        `INSERT INTO booking.affiliate_validation_probe_revocations(probe_id,actor_id,organization_id,request_id)
        VALUES($1,$2,$3,$4) ON CONFLICT(probe_id) DO NOTHING`,
        [probeId, actorId, organizationId, context.audit.requestId],
      );
      await client.query("COMMIT");
      return { ok: true, revoked: true };
    }
    if (
      row.revoked ||
      !row.unexpired ||
      row.environment !== deployment.environment ||
      row.connection_reference !== deployment.connectionReference ||
      row.adapter_version !== deployment.adapterVersion
    ) {
      await client.query("ROLLBACK");
      return { ok: false, code: "probe_unavailable" };
    }
    await client.query("COMMIT");
    return {
      ok: true,
      purpose: "validation",
      probe: `avp_${probeId}`,
      expiresAt: row.expires_at.toISOString(),
      replayed,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Caller owns the transaction; locks remain held through the dependent write. */
export async function lockAffiliateValidationScope(
  client: pg.PoolClient,
  context: RequestContext,
  propertyId: string,
  destinationId: string,
): Promise<boolean> {
  if (
    context.actor.status !== "active" ||
    context.membership.status !== "active" ||
    context.selectedOrganization.status !== "active" ||
    context.selectedOrganization.kind !== "hotel_group"
  )
    return false;
  const organizationId = context.selectedOrganization.organizationId;
  const resource = {
    product: "marketplace" as const,
    resourceType: "hotel_profile" as const,
    resourceId: propertyId,
  };
  requireResourceAccess(context, {
    permission: "marketplace.profile.manage",
    resource: { ...resource, allowedRelationships: ["owner", "operator"] },
  });
  requireActiveEntitlement(context, {
    product: "marketplace",
    key: "marketplace-hotel-profile",
    resource,
  });
  const scope = await client.query(
    `SELECT p.id FROM hotel_catalog.properties p
      JOIN identity.organization_resource_links l ON l.resource_id=p.id::text
      JOIN booking.affiliate_destination_versions d ON d.property_id=p.id AND d.id=$3 AND d.created_by_organization_id=$2
      WHERE p.id=$1 AND p.profile_status <> 'disabled' AND l.organization_id=$2
      AND l.product='marketplace' AND l.resource_type='hotel_profile' AND l.status='active' AND l.relationship IN ('owner','operator')
      ORDER BY l.id FOR UPDATE OF p,l`,
    [propertyId, organizationId, destinationId],
  );
  return !!scope.rowCount;
}
