import type { Pool } from "pg";
import { lockAdminTransferSnapshot } from "./accountAdminTransferSnapshot.js";
import {
  adminTransferRequestDigest,
  parseAdminTransferRequest,
  validateAdminTransferRequest,
} from "./accountAdminTransferValidation.js";
import { consumeAdminTransferProof } from "./accountAdminTransferProofs.js";
import { enqueueInboxAssignmentReconciliation } from "./staffInvitations.js";

type Source = {
  organizationId: string;
  actorMembershipId: string;
  actorUserId: string;
  workosUserId: string;
  workosOrgId: string;
  sessionId: string;
};
/** Internal command; source comes only from a freshly authenticated live browser session. */
export async function runAdminTransfer(pool: Pool, source: Source, raw: unknown, proofId: string) {
  const request = parseAdminTransferRequest(raw);
  if (
    !request ||
    !source.sessionId ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(proofId)
  )
    return { outcome: "rejected", reason: "invalid_transfer" } as const;
  proofId = proofId.toLowerCase();
  const binding = {
    ...source,
    targetMembershipId: request.targetMembershipId,
    requestDigest: adminTransferRequestDigest(request, source),
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const org = await client.query(
      `SELECT id FROM identity.organizations WHERE id=$1 AND kind='hotel_group' AND status='active' AND workos_org_id=$2 FOR UPDATE`,
      [source.organizationId, source.workosOrgId],
    );
    if (!org.rowCount) {
      await client.query("ROLLBACK");
      return { outcome: "rejected", reason: "forbidden" } as const;
    }
    // Replay returns only this active actor's own completed receipt, never new ownership authority.
    const replay = await client.query(
      `SELECT p.id FROM identity.account_admin_transfer_proofs p
      JOIN identity.organization_memberships m ON m.id=p.actor_membership_id AND m.organization_id=p.organization_id
      JOIN identity.users u ON u.id=m.user_id
      JOIN identity.external_identities e ON e.user_id=u.id AND e.provider='workos' AND e.provider_user_id=p.workos_user_id
      JOIN platform.product_audit_events a ON a.audit_key='admin.transfer:' || p.id::text AND a.organization_id=p.organization_id
      WHERE p.id=$1 AND p.organization_id=$2 AND p.actor_membership_id=$3 AND p.target_membership_id=$4
        AND p.workos_user_id=$5 AND p.workos_org_id=$6 AND p.source_session_id=$7 AND p.request_digest=$8
        AND p.consumed_at IS NOT NULL AND m.user_id=$9 AND m.status='active' AND u.status='active'
      FOR SHARE OF m,u,e`,
      [
        proofId,
        source.organizationId,
        source.actorMembershipId,
        request.targetMembershipId,
        source.workosUserId,
        source.workosOrgId,
        source.sessionId,
        binding.requestDigest,
        source.actorUserId,
      ],
    );
    if (replay.rowCount) {
      await client.query("COMMIT");
      return { outcome: "idempotent_replay" } as const;
    }
    const snapshot = await lockAdminTransferSnapshot(client, {
      ...source,
      targetMembershipId: request.targetMembershipId,
      formerAdminRoleId: request.formerAdmin.roleDefinitionId,
    });
    if (!snapshot) {
      await client.query("ROLLBACK");
      return { outcome: "rejected", reason: "forbidden" } as const;
    }
    const validated = validateAdminTransferRequest(request, {
      ...source,
      actorRevision: snapshot.actor.revision,
      targetMembershipId: snapshot.target.id,
      targetRevision: snapshot.target.revision,
      role: snapshot.formerAdminRole,
      propertyIds: snapshot.propertyIds,
    });
    if (!validated.ok) {
      await client.query("ROLLBACK");
      return { outcome: "rejected", reason: validated.error } as const;
    }
    if (!(await consumeAdminTransferProof(client, binding, proofId))) {
      await client.query("ROLLBACK");
      return { outcome: "rejected", reason: "invalid_proof" } as const;
    }
    await client.query(
      "INSERT INTO identity.account_admin_guards(organization_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [source.organizationId],
    );
    await client.query(
      "DELETE FROM identity.membership_delegations WHERE organization_id=$1 AND subject_membership_id=$2",
      [source.organizationId, snapshot.target.id],
    );
    await client.query(
      "DELETE FROM identity.membership_property_assignments WHERE membership_id=ANY($1::uuid[])",
      [[snapshot.actor.id, snapshot.target.id]],
    );
    const access = validated.request.formerAdmin;
    await client.query(
      `UPDATE identity.organization_memberships SET role_key=$2, role_definition_id=$3, permission_overrides=$4::jsonb,
      property_access_mode=$5, pms_access_enabled=$6, booking_access_enabled=$7, access_origin='agency', updated_at=clock_timestamp() WHERE id=$1`,
      [
        snapshot.actor.id,
        snapshot.formerAdminRole.baseRoleKey,
        access.roleDefinitionId,
        JSON.stringify(access.permissionOverrides),
        access.propertyAccessMode,
        access.productAccess.pms,
        access.productAccess.booking,
      ],
    );
    await client.query(
      `INSERT INTO identity.membership_property_assignments(membership_id,property_id)
      SELECT $1, id FROM unnest($2::uuid[]) id`,
      [snapshot.actor.id, access.propertyIds],
    );
    await client.query(
      `UPDATE identity.organization_memberships SET role_key='hotel_owner', role_definition_id=$2,
      permission_overrides='{"grant":[],"deny":[]}'::jsonb, property_access_mode='all', access_origin='agency',
      pms_access_enabled=true, booking_access_enabled=true, updated_at=clock_timestamp() WHERE id=$1`,
      [snapshot.target.id, snapshot.adminRoleId],
    );
    for (const member of [snapshot.actor, snapshot.target]) {
      await client.query(
        `INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,organization_id,resource_product,resource_type,resource_id,payload)
        VALUES ($1,'identity-admin-transfer','identity.membership_role.reconcile','organization',$2,'identity','organization_membership',$3,
          jsonb_build_object('membershipId',$3::text))`,
        [`admin.transfer:${proofId}:${member.id}`, source.organizationId, member.id],
      );
      await enqueueInboxAssignmentReconciliation(client, {
        organizationId: source.organizationId,
        membershipId: member.id,
        idempotencyId: proofId,
        correlationId: proofId,
        commandId: proofId,
        reason: "role_permissions_changed",
      });
    }
    const before = [snapshot.actor, snapshot.target].map((m) => ({
      membershipId: m.id,
      role: m.role_key,
      roleDefinitionId: m.role_definition_id,
      propertyAccessMode: m.property_access_mode,
      propertyIds: m.property_ids,
      accessOrigin: m.access_origin,
      permissionOverrides: m.permission_overrides,
      productAccess: { pms: m.pms_access_enabled, booking: m.booking_access_enabled },
      revision: m.revision,
    }));
    await client.query(
      `INSERT INTO platform.product_audit_events(audit_key,product,action,occurred_at,tenant_scope,organization_id,
      actor_type,actor_user_id,target_resource_product,target_resource_type,target_resource_id,redacted_payload,retention_class,privacy_scope)
      VALUES ($1,'identity','identity.account_admin.transferred',clock_timestamp(),'organization',$2,'user',$3,'identity','organization_membership',$4,
        $5::jsonb,'security','confidential')`,
      [
        `admin.transfer:${proofId}`,
        source.organizationId,
        source.actorUserId,
        snapshot.target.id,
        JSON.stringify({
          before,
          after: {
            admin: {
              membershipId: snapshot.target.id,
              roleDefinitionId: snapshot.adminRoleId,
              role: "hotel_owner",
              propertyAccessMode: "all",
              propertyIds: [],
              accessOrigin: "agency",
              permissionOverrides: { grant: [], deny: [] },
              productAccess: { pms: true, booking: true },
            },
            formerAdmin: { membershipId: snapshot.actor.id, accessOrigin: "agency", ...access },
          },
          requestDigest: binding.requestDigest,
        }),
      ],
    );
    await client.query("COMMIT");
    return { outcome: "transferred" } as const;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
