import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { RequestContext } from "@vayada/backend-auth";
import {
  requireActiveEntitlement,
  requirePropertyAccess,
  requireResourceAccess,
} from "@vayada/backend-authorization";

type Input = {
  context: RequestContext;
  propertyId: string;
  programId: string;
  creatorProfileId: string;
  termsId: string;
  attemptId: string;
  expectedRevision: number;
  idempotencyKey: string;
  decision: "hotel_approval" | "creator_acceptance";
  disclosureHash: string;
  collaborationId?: string;
};
type Result =
  | {
      ok: true;
      participationId: string;
      attemptId: string;
      decisionId: string;
      revision: number;
      state: "pending" | "matched";
      replayed: boolean;
    }
  | { ok: false; code: string };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const uuid = (s: unknown): s is string =>
  typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const operation = "marketplace.affiliate.initial_assent";
/** Fresh trusted context on every call. Matched is assent only, never activation/earning eligibility. */
export async function recordAffiliateAssent(pool: pg.Pool, input: Input): Promise<Result> {
  if (
    ![
      input.propertyId,
      input.programId,
      input.creatorProfileId,
      input.termsId,
      input.attemptId,
    ].every(uuid) ||
    ![0, 1].includes(input.expectedRevision) ||
    !["hotel_approval", "creator_acceptance"].includes(input.decision) ||
    typeof input.disclosureHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.disclosureHash) ||
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 200 ||
    !input.context.audit.requestId.trim() ||
    input.context.audit.requestId.length > 200 ||
    (input.collaborationId !== undefined &&
      (input.collaborationId.length > 100 || !/^[A-Za-z0-9._~:-]+$/.test(input.collaborationId)))
  )
    return { ok: false, code: "invalid_request" };
  const [propertyId, programId, creatorProfileId, termsId, attemptId] = [
    input.propertyId,
    input.programId,
    input.creatorProfileId,
    input.termsId,
    input.attemptId,
  ].map((s) => s.toLowerCase());
  const { context, decision, expectedRevision, disclosureHash } = input;
  const hotel = decision === "hotel_approval",
    actorId = context.actor.internalUserId,
    organizationId = context.selectedOrganization.organizationId;
  if (
    context.actor.status !== "active" ||
    context.membership.status !== "active" ||
    context.selectedOrganization.status !== "active" ||
    context.selectedOrganization.kind !== (hotel ? "hotel_group" : "creator_workspace")
  )
    return { ok: false, code: "scope_unavailable" };
  const resource = {
    product: "marketplace" as const,
    resourceType: hotel ? ("hotel_profile" as const) : ("creator_profile" as const),
    resourceId: hotel ? propertyId : creatorProfileId,
  };
  requireResourceAccess(context, {
    permission: "marketplace.collaboration.write",
    resource: { ...resource, allowedRelationships: hotel ? ["owner", "operator"] : ["owner"] },
  });
  if (hotel) {
    requireActiveEntitlement(context, {
      product: "marketplace",
      key: "marketplace-hotel-profile",
      resource,
    });
    await requirePropertyAccess(
      context,
      { findMembershipPropertyScope: async () => null },
      {
        propertyId,
        targetResource: { product: "marketplace", resourceType: "hotel_profile" },
        allowedRelationships: ["owner", "operator"],
      },
    );
  } else {
    const owned = context.linkedResources.filter(
      (r) =>
        r.product === "marketplace" &&
        r.resourceType === "creator_profile" &&
        r.relationship === "owner" &&
        r.status === "active",
    );
    if (owned.length !== 1 || owned[0].resourceId !== creatorProfileId)
      return { ok: false, code: "scope_unavailable" };
  }
  const key = hash(JSON.stringify([programId, creatorProfileId, input.idempotencyKey]));
  const fingerprint = hash(
    JSON.stringify([
      propertyId,
      programId,
      creatorProfileId,
      termsId,
      attemptId,
      organizationId,
      actorId,
      decision,
      expectedRevision,
      disclosureHash,
      input.collaborationId ?? null,
    ]),
  );
  const client = await pool.connect();
  let collaborationStatus: string | null = null;
  const fail = async (code: string): Promise<Result> => {
    await client.query("ROLLBACK");
    return { ok: false, code };
  };
  const success = (
    row: { id: string; revision: number; participation_id: string },
    replayed: boolean,
  ): Result => ({
    ok: true,
    participationId: row.participation_id,
    attemptId,
    decisionId: row.id,
    revision: row.revision,
    state: row.revision === 2 ? "matched" : "pending",
    replayed,
  });
  try {
    await client.query("BEGIN");
    const scope = await client.query(
      `SELECT p.organization_id,p.offer_id,c.organization_id AS creator_organization_id,c.owner_user_id
      FROM marketplace.affiliate_programs p JOIN marketplace.marketplace_offers o ON o.id=p.offer_id
      JOIN hotel_catalog.properties h ON h.id=p.property_id CROSS JOIN marketplace.creator_profiles c
      WHERE p.id=$1 AND p.property_id=$2 AND c.id=$3 AND c.profile_status='active'
        AND o.offer_status='verified' AND h.profile_status<>'disabled' FOR UPDATE OF p,c,o,h`,
      [programId, propertyId, creatorProfileId],
    );
    const target = scope.rows[0];
    if (
      !target ||
      (hotel
        ? target.organization_id !== organizationId
        : target.creator_organization_id !== organizationId || target.owner_user_id !== actorId)
    )
      return await fail("scope_unavailable");
    if (hotel)
      requireResourceAccess(context, {
        permission: "marketplace.collaboration.write",
        resource: {
          product: "marketplace",
          resourceType: "marketplace_offer",
          resourceId: target.offer_id,
          allowedRelationships: ["owner", "operator"],
        },
      });
    const links = await client.query(
      `SELECT id FROM identity.organization_resource_links WHERE organization_id=$1 AND product='marketplace'
      AND resource_type=$2 AND resource_id=$3 AND status='active' AND relationship=ANY($4::text[]) FOR SHARE`,
      [
        organizationId,
        hotel ? "hotel_profile" : "creator_profile",
        hotel ? propertyId : creatorProfileId,
        hotel ? ["owner", "operator"] : ["owner"],
      ],
    );
    if (!links.rowCount) return await fail("scope_unavailable");
    if (input.collaborationId) {
      const collaboration = await client.query<{ lifecycle_status: string }>(
        `SELECT lifecycle_status FROM marketplace.collaborations
         WHERE source_collaboration_id=$1 AND property_id=$2 AND offer_id=$3
           AND hotel_organization_id=$4 AND creator_profile_id=$5
           AND creator_organization_id=$6 FOR UPDATE`,
        [
          input.collaborationId,
          propertyId,
          target.offer_id,
          target.organization_id,
          creatorProfileId,
          target.creator_organization_id,
        ],
      );
      if (collaboration.rowCount !== 1) return await fail("scope_unavailable");
      collaborationStatus = collaboration.rows[0]!.lifecycle_status;
    }
    const prior = await client.query(
      `SELECT k.request_fingerprint_hash,k.status,d.id,d.revision,a.participation_id FROM platform.idempotency_keys k
      LEFT JOIN marketplace.affiliate_assent_decisions d ON d.id::text=k.response_resource_id
        AND d.attempt_id=$4 AND d.terms_id=$5 AND d.actor_user_id=$6 AND d.actor_organization_id=$7 AND d.decision=$8
      LEFT JOIN marketplace.affiliate_participation_attempts a ON a.id=d.attempt_id
      WHERE k.operation_scope='marketplace' AND k.operation=$1 AND k.tenant_scope='property' AND k.property_id=$2 AND k.key_hash=$3`,
      [operation, propertyId, key, attemptId, termsId, actorId, organizationId, decision],
    );
    const saved = prior.rows[0];
    if (
      saved &&
      (saved.status !== "completed" || saved.request_fingerprint_hash !== fingerprint || !saved.id)
    )
      return await fail("idempotency_conflict");
    const terms = await client.query(
      "SELECT disclosure,disclosure_hash FROM marketplace.affiliate_published_terms WHERE id=$1 AND program_id=$2",
      [termsId, programId],
    );
    if (
      !terms.rows[0] ||
      terms.rows[0].disclosure_hash !== disclosureHash ||
      hash(terms.rows[0].disclosure) !== disclosureHash
    )
      return await fail("terms_unavailable");
    if (saved) {
      await client.query("ROLLBACK");
      return success(saved, true);
    }
    if (
      collaborationStatus &&
      ["declined", "cancelled", "rejected"].includes(collaborationStatus)
    )
      return await fail("transition_unavailable");
    let participation = (
      await client.query(
        "SELECT id FROM marketplace.affiliate_participations WHERE program_id=$1 AND creator_profile_id=$2 AND creator_organization_id=$3",
        [programId, creatorProfileId, target.creator_organization_id],
      )
    ).rows[0];
    const attempt = (
      await client.query(
        "SELECT id,participation_id,terms_id,attempt_number FROM marketplace.affiliate_participation_attempts WHERE id=$1",
        [attemptId],
      )
    ).rows[0];
    if (participation) {
      if (
        !attempt ||
        attempt.attempt_number !== 1 ||
        attempt.participation_id !== participation.id ||
        attempt.terms_id !== termsId
      )
        return await fail("attempt_conflict");
    } else {
      if (attempt || expectedRevision !== 0) return await fail("attempt_conflict");
      participation = { id: randomUUID() };
      await client.query("INSERT INTO marketplace.affiliate_participations VALUES ($1,$2,$3,$4)", [
        participation.id,
        programId,
        creatorProfileId,
        target.creator_organization_id,
      ]);
      await client.query(
        `INSERT INTO marketplace.affiliate_participation_attempts
        (id,participation_id,program_id,terms_id,attempt_number,origin,actor_user_id,actor_organization_id,request_id)
        VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8)`,
        [
          attemptId,
          participation.id,
          programId,
          termsId,
          hotel ? "invitation" : "application",
          actorId,
          organizationId,
          context.audit.requestId,
        ],
      );
    }
    const decisions = await client.query(
      "SELECT decision,revision FROM marketplace.affiliate_assent_decisions WHERE attempt_id=$1",
      [attemptId],
    );
    if (
      decisions.rows.length !== expectedRevision ||
      decisions.rows.some((row) => row.decision === decision)
    )
      return await fail("revision_conflict");
    const decisionId = randomUUID(),
      revision = expectedRevision + 1;
    await client.query(
      `INSERT INTO marketplace.affiliate_assent_decisions
      (id,attempt_id,terms_id,decision,revision,disclosure_hash,actor_user_id,actor_organization_id,request_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        decisionId,
        attemptId,
        termsId,
        decision,
        revision,
        disclosureHash,
        actorId,
        organizationId,
        context.audit.requestId,
      ],
    );
    await client.query(
      `INSERT INTO platform.idempotency_keys
      (operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,property_id,response_status_code,
       response_resource_product,response_resource_type,response_resource_id,correlation_id,completed_at,expires_at)
      VALUES ('marketplace',$1,$2,$3,'completed','property',$4,201,'marketplace','affiliate_assent_decision',$5,$6,now(),now()+interval '90 days')`,
      [
        operation,
        key,
        fingerprint,
        propertyId,
        decisionId,
        context.audit.correlationId ?? context.audit.requestId,
      ],
    );
    await client.query("COMMIT");
    return success({ id: decisionId, revision, participation_id: participation.id }, false);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
