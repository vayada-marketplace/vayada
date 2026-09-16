import type { Pool } from "pg";
import { createAdminTransferProof } from "./accountAdminTransferProofs.js";
import { lockAdminTransferSnapshot } from "./accountAdminTransferSnapshot.js";
import {
  parseAdminTransferRequest,
  validateAdminTransferRequest,
} from "./accountAdminTransferValidation.js";

export type AdminTransferSessionSource = {
  organizationId: string;
  actorUserId: string;
  workosUserId: string;
  workosOrgId: string;
  sessionId: string;
};
export type AdminTransferSource = AdminTransferSessionSource & { actorMembershipId: string };

/** Resolve the current canonical owner for a freshly authenticated browser session. */
export async function resolveAdminTransferSource(
  pool: Pool,
  source: AdminTransferSessionSource,
): Promise<AdminTransferSource | null> {
  if (!source.sessionId) return null;
  const result = await pool.query<{ id: string }>(
    `SELECT membership.id
     FROM identity.organizations organization
     JOIN identity.organization_memberships membership
       ON membership.organization_id = organization.id
     JOIN identity.users actor ON actor.id = membership.user_id
     JOIN identity.external_identities external
       ON external.user_id = actor.id AND external.provider = 'workos'
     WHERE organization.id = $1 AND organization.kind = 'hotel_group'
       AND organization.status = 'active' AND organization.workos_org_id = $2
       AND membership.user_id = $3 AND membership.role_key = 'hotel_owner'
       AND membership.status = 'active' AND actor.status = 'active'
       AND external.provider_user_id = $4`,
    [source.organizationId, source.workosOrgId, source.actorUserId, source.workosUserId],
  );
  return result.rowCount === 1 ? { ...source, actorMembershipId: result.rows[0]!.id } : null;
}

/** Lock and validate the complete transfer intent before creating reauthentication state. */
export async function prepareAdminTransferProof(
  pool: Pool,
  source: AdminTransferSource,
  raw: unknown,
): Promise<
  | {
      outcome: "prepared";
      proofId: string;
      state: string;
      binding: Parameters<typeof createAdminTransferProof>[1];
    }
  | {
      outcome: "rejected";
      reason: "invalid_transfer" | "stale_transfer" | "invalid_former_admin_access" | "forbidden";
    }
> {
  const request = parseAdminTransferRequest(raw);
  if (!request) return { outcome: "rejected", reason: "invalid_transfer" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const snapshot = await lockAdminTransferSnapshot(client, {
      ...source,
      targetMembershipId: request.targetMembershipId,
      formerAdminRoleId: request.formerAdmin.roleDefinitionId,
    });
    if (!snapshot) {
      await client.query("ROLLBACK");
      return { outcome: "rejected", reason: "forbidden" };
    }
    const validated = validateAdminTransferRequest(raw, {
      organizationId: source.organizationId,
      actorMembershipId: source.actorMembershipId,
      actorRevision: snapshot.actor.revision,
      targetMembershipId: snapshot.target.id,
      targetRevision: snapshot.target.revision,
      role: snapshot.formerAdminRole,
      propertyIds: snapshot.propertyIds,
    });
    if (!validated.ok) {
      await client.query("ROLLBACK");
      return { outcome: "rejected", reason: validated.error };
    }
    const binding = {
      ...source,
      targetMembershipId: validated.request.targetMembershipId,
      requestDigest: validated.requestDigest,
    };
    const proof = await createAdminTransferProof(client, binding);
    await client.query("COMMIT");
    return { outcome: "prepared", proofId: proof.id, state: proof.state, binding };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
