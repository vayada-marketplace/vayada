import { listAccountAdmins } from "./accountAdmins.js";
import { createHash } from "node:crypto";
import pg from "pg";

import {
  hasValidStaffPermissionHierarchy,
  hotelStaffRoleKeys,
  staffAccessPermissionKeys,
  parseStaffPermissionOverrides,
  validateStaffPermissionOverrides,
  validateStaffInviteAccess,
  type CreateStaffInviteCommand,
  type HotelStaffRoleKey,
  type RemoveStaffCommand,
  type UpdateStaffAccessCommand,
  type UpdateStaffStatusCommand,
} from "./lifecycle.js";
import type { RepositoryConfig } from "./repository.js";
import type { PermissionKey } from "./types.js";
import { loadManagedStaffAccess, withinStaffManagementScope } from "./staffManagement.js";
import { resolveTeamRolePermissions, type TeamRolePolicy } from "./teamRolePolicy.js";
import { staffAccessRevision, type StaffAccessRevisionRow } from "./staffAccessRevision.js";

type StaffRoleDefinition = TeamRolePolicy & { id: string; name: string; revision: string };

type InviterRow = {
  membership_id: string;
  role_key: string;
  role_definition_id: string | null;
  role_definition: StaffRoleDefinition | null;
  access_origin: string;
  property_access_mode: string;
  name: string | null;
  email: string;
  permission_overrides: unknown;
  role_permissions: string[];
};
type InvitationRow = {
  id: string;
  request_fingerprint_hash: Buffer;
  supersedes_invitation_id: string | null;
};
type StaffRosterRow = {
  id: string;
  name: string | null;
  email: string;
  role_key: HotelStaffRoleKey;
  role_definition_id: string | null;
  role_name: string | null;
  property_access_mode: "all" | "assigned";
  property_ids: string[];
  status: StaffRosterMember["status"];
  last_active_at: Date | null;
};
export type StaffAccessTargetRow = StaffAccessRevisionRow & {
  role_definition_id: string | null;
  role_definition: StaffRoleDefinition | null;
  pms_access_enabled: boolean;
  booking_access_enabled: boolean;
  status: "active" | "suspended";
};
type StaffStatusTargetRow = {
  user_id: string;
  status: "active" | "suspended";
};
type StaffRemovalTargetRow = {
  user_id: string;
  status: "active" | "suspended";
  workos_membership_id: string | null;
  workos_org_id: string | null;
  workos_user_ids: string[];
};

export type StaffRosterMember = {
  id: string;
  name: string | null;
  email: string;
  roleKey: HotelStaffRoleKey;
  roleDefinitionId: string | null;
  roleName: string | null;
  propertyAccessMode: "all" | "assigned";
  propertyIds: string[];
  status: "active" | "pending" | "deactivated";
  lastActiveAt: string | null;
};

const permissionKeys = new Set<string>(staffAccessPermissionKeys);
const staffAccessUpdateOperation = "staff_access_update";
const staffStatusUpdateOperation = "staff_status_update";
const staffRemovalOperation = "staff_remove";
const inboxAssignmentReconciliationJobType = "pms.inbox.assignment.reconcile";

export function createPgStaffInvitationRepository(config: RepositoryConfig) {
  if (!config.connectionString.trim()) {
    throw new Error("Staff invitation repository connectionString must not be empty");
  }
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    listAccountAdmins: (organizationId: string) => listAccountAdmins(pool, organizationId),
    async prepareInvitation(organizationId: string, email: string) {
      const result = await pool.query<{ revision: number; pending: boolean }>(
        `SELECT COALESCE(max(configuration_revision), 0) + 1 AS revision,
                COALESCE(bool_or(status = 'pending' AND (expires_at IS NULL OR expires_at > now())), false) AS pending
         FROM identity.staff_invitations WHERE organization_id = $1 AND email = $2`,
        [organizationId, email.trim().toLowerCase()],
      );
      const row = result.rows[0]!;
      return row.pending ? null : { configurationRevision: row.revision };
    },
    async getInvitation(organizationId: string, invitationId: string) {
      if (!canonicalUuid(invitationId)) return null;
      const result = await pool.query<{
        id: string;
        email: string;
        name: string | null;
        roleKey: HotelStaffRoleKey;
        propertyAccessMode: "all" | "assigned";
        propertyIds: string[];
        permissionOverrides: unknown;
        configurationRevision: number;
        productAccess: { pms: boolean; booking: boolean };
        roleDefinitionId: string | null;
        roleDefinition: StaffRoleDefinition | null;
        deliveryState: string;
        expiresAt: Date | null;
      }>(
        `SELECT invitation.id, invitation.email, invitation.display_name AS name,
                invitation.role_key AS "roleKey", invitation.property_access_mode AS "propertyAccessMode",
                invitation.permission_overrides AS "permissionOverrides", invitation.configuration_revision AS "configurationRevision",
                jsonb_build_object('pms', invitation.pms_access_enabled, 'booking', invitation.booking_access_enabled) AS "productAccess",
                invitation.role_definition_id AS "roleDefinitionId", invitation.delivery_state AS "deliveryState", invitation.expires_at AS "expiresAt",
                CASE WHEN definition.id IS NULL THEN NULL ELSE jsonb_build_object(
                  'id', definition.id, 'name', definition.name, 'revision', definition.revision::text,
                  'securityClass', definition.security_class, 'baseRoleKey', definition.base_role_key,
                  'presetKey', definition.preset_key, 'defaultPermissions', definition.default_permissions
                ) END AS "roleDefinition",
                ARRAY(SELECT property_id::text FROM identity.staff_invitation_property_assignments
                      WHERE invitation_id = invitation.id ORDER BY property_id) AS "propertyIds"
         FROM identity.staff_invitations invitation
         JOIN identity.organizations organization ON organization.id = invitation.organization_id
         LEFT JOIN identity.organization_roles definition ON definition.id = invitation.role_definition_id AND definition.organization_id = invitation.organization_id
         WHERE invitation.organization_id = $1 AND invitation.id = $2 AND invitation.status = 'pending'
           AND organization.kind = 'hotel_group' AND organization.status = 'active'`,
        [organizationId, invitationId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const overrides = parseStaffPermissionOverrides(row.permissionOverrides);
      if (
        !overrides ||
        validateStaffInviteAccess({ ...row, permissionOverrides: overrides }).filter(
          (issue) => row.roleDefinitionId === null || issue !== "missing_required_permission",
        ).length ||
        (row.roleDefinitionId !== null &&
          (!row.roleDefinition ||
            row.roleDefinition.baseRoleKey !== row.roleKey ||
            !resolveTeamRolePermissions(row.roleDefinition, overrides)))
      )
        throw new Error("Invitation configuration is unavailable");
      return {
        ...row,
        permissionOverrides: overrides,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      };
    },
    async getAccess(organizationId: string, membershipId: string) {
      const result = await pool.query<
        StaffAccessTargetRow & {
          scope_valid: boolean;
        }
      >(
        `SELECT membership.id, membership.role_key, membership.permission_overrides,
                membership.property_access_mode, membership.access_origin, membership.status,
                membership.updated_at::text AS updated_at,
                membership.pms_access_enabled, membership.booking_access_enabled,
                membership.role_definition_id,
                CASE WHEN definition.id IS NULL THEN NULL ELSE jsonb_build_object(
                  'id', definition.id, 'name', definition.name, 'revision', definition.revision::text,
                  'securityClass', definition.security_class, 'baseRoleKey', definition.base_role_key,
                  'presetKey', definition.preset_key, 'defaultPermissions', definition.default_permissions
                ) END AS role_definition,
                ARRAY(SELECT assignment.property_id::text
                      FROM identity.membership_property_assignments assignment
                      WHERE assignment.membership_id = membership.id
                      ORDER BY assignment.property_id) AS property_ids,
                NOT EXISTS (
                  SELECT 1 FROM identity.membership_property_assignments assignment
                  WHERE assignment.membership_id = membership.id AND NOT EXISTS (
                    SELECT 1 FROM identity.organization_resource_links link
                    WHERE link.organization_id = membership.organization_id
                      AND link.product = 'hotel_catalog' AND link.resource_type = 'property'
                      AND link.resource_id = assignment.property_id::text
                      AND link.relationship IN ('owner', 'operator') AND link.status = 'active'
                  )
                ) AS scope_valid,
                ARRAY(SELECT permission_key FROM identity.role_permission_grants
                      WHERE organization_kind = 'hotel_group'
                        AND role_key = membership.role_key ORDER BY permission_key) AS role_permissions
         FROM identity.organization_memberships membership
         JOIN identity.organizations organization ON organization.id = membership.organization_id
         LEFT JOIN identity.organization_roles definition
           ON definition.id = membership.role_definition_id AND definition.organization_id = membership.organization_id
         WHERE membership.organization_id = $1 AND membership.id::text = $2
           AND organization.kind = 'hotel_group' AND organization.status = 'active'
           AND membership.role_key = ANY($3::text[])
           AND membership.status IN ('active', 'suspended')`,
        [organizationId, membershipId, hotelStaffRoleKeys],
      );
      const row = result.rows[0];
      if (!row) return null;
      const permissionOverrides =
        row.permission_overrides === null
          ? { grant: [], deny: [] }
          : parseStaffPermissionOverrides(row.permission_overrides);
      const configuredPermissions = resolveSavedStaffPermissions(row, permissionOverrides);
      if (
        row.access_origin !== "agency" ||
        (row.role_key === "external_owner" && row.property_access_mode !== "assigned") ||
        !row.scope_valid ||
        !["all", "assigned"].includes(row.property_access_mode) ||
        !permissionOverrides ||
        !configuredPermissions
      )
        throw new Error("Staff access configuration is unavailable");
      return {
        membershipId: row.id,
        roleDefinitionId: row.role_definition_id,
        roleDefinition: row.role_definition,
        configuredPermissions,
        revision: staffAccessRevision(row),
        productAccess: { pms: row.pms_access_enabled, booking: row.booking_access_enabled },
        roleKey: row.role_key as HotelStaffRoleKey,
        status: row.status,
        propertyAccessMode: row.property_access_mode as "all" | "assigned",
        propertyIds: row.property_ids,
        permissionOverrides,
      };
    },
    async listRoster(organizationId: string): Promise<StaffRosterMember[]> {
      const result = await pool.query<StaffRosterRow>(
        `WITH canonical_properties AS (
           SELECT DISTINCT property.id AS property_id
           FROM identity.organizations organization
           JOIN identity.organization_resource_links link
             ON link.organization_id = organization.id
           JOIN hotel_catalog.properties property ON property.id::text = link.resource_id
           WHERE organization.id = $1 AND organization.kind = 'hotel_group'
             AND organization.status = 'active' AND link.product = 'hotel_catalog'
             AND link.resource_type = 'property' AND link.relationship IN ('owner', 'operator')
             AND link.status = 'active'
         ), roster AS (
           SELECT membership.id, staff.name, staff.email, membership.role_key,
                  membership.role_definition_id, definition.name AS role_name, membership.property_access_mode,
                  CASE WHEN membership.status = 'active' AND staff.status = 'active'
                    THEN 'active' ELSE 'deactivated' END AS status,
                  (SELECT max(external.last_login_at)
                   FROM identity.external_identities external
                   WHERE external.user_id = staff.id AND external.provider = 'workos') AS last_active_at,
                  ARRAY(
                    SELECT property.property_id::text FROM canonical_properties property
                    WHERE membership.property_access_mode = 'all'
                       OR EXISTS (
                         SELECT 1 FROM identity.membership_property_assignments assignment
                         WHERE assignment.membership_id = membership.id
                           AND assignment.property_id = property.property_id
                       )
                    ORDER BY property.property_id
                  ) AS property_ids
           FROM identity.organization_memberships membership
           JOIN identity.users staff ON staff.id = membership.user_id
           LEFT JOIN identity.organization_roles definition ON definition.id = membership.role_definition_id
             AND definition.organization_id = membership.organization_id
           JOIN identity.organizations organization ON organization.id = membership.organization_id
           WHERE membership.organization_id = $1 AND organization.kind = 'hotel_group'
             AND organization.status = 'active'
             AND membership.role_key = ANY($2::text[])
             AND membership.status IN ('active', 'suspended')
           UNION ALL
           SELECT invitation.id, invitation.display_name, invitation.email, invitation.role_key,
                  invitation.role_definition_id, definition.name, invitation.property_access_mode,
                  'pending', NULL,
                  ARRAY(
                    SELECT property.property_id::text
                    FROM canonical_properties property
                    WHERE invitation.property_access_mode = 'all' OR EXISTS (
                      SELECT 1 FROM identity.staff_invitation_property_assignments assignment
                      WHERE assignment.invitation_id = invitation.id AND assignment.property_id = property.property_id
                    )
                    ORDER BY property.property_id
                  )
           FROM identity.staff_invitations invitation
           LEFT JOIN identity.organization_roles definition ON definition.id = invitation.role_definition_id
             AND definition.organization_id = invitation.organization_id
           JOIN identity.organizations organization ON organization.id = invitation.organization_id
           WHERE invitation.organization_id = $1 AND organization.kind = 'hotel_group'
             AND organization.status = 'active' AND invitation.status = 'pending'
             AND (invitation.expires_at IS NULL OR invitation.expires_at > now())
         )
         SELECT id, name, email, role_key, role_definition_id, role_name, property_access_mode, property_ids, status, last_active_at
         FROM roster
         ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                  lower(COALESCE(name, email)), id`,
        [organizationId, hotelStaffRoleKeys],
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        roleKey: row.role_key,
        roleDefinitionId: row.role_definition_id,
        roleName: row.role_name,
        propertyAccessMode: row.property_access_mode,
        propertyIds: row.property_ids,
        status: row.status,
        lastActiveAt: row.last_active_at?.toISOString() ?? null,
      }));
    },
    async updateStatus(command: UpdateStaffStatusCommand) {
      const normalized = normalizeStaffStatusUpdate(command);
      if (!normalized) return { outcome: "rejected" as const, reason: "invalid_command" as const };
      const keyHash = hash(command.idempotencyKey).toString("hex");
      const fingerprint = hash(JSON.stringify(normalized)).toString("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const manager = await lockAuthorizedManager(
          client,
          normalized.organizationId,
          normalized.actorUserId,
        );
        if (!manager) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "inviter_not_authorized" as const };
        }
        const reservation = await client.query<{ id: string }>(
          `INSERT INTO platform.idempotency_keys
             (operation_scope, operation, key_hash, request_fingerprint_hash, status,
              tenant_scope, organization_id, correlation_id, expires_at, idempotency_metadata)
           VALUES ('identity', $1, $2, $3, 'in_progress', 'organization', $4, $5,
                   now() + interval '30 days', jsonb_build_object('commandId', $6::text))
           ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
           RETURNING id::text AS id`,
          [
            staffStatusUpdateOperation,
            keyHash,
            fingerprint,
            normalized.organizationId,
            command.audit.correlationId ?? command.audit.requestId,
            command.commandId,
          ],
        );
        const reservationId = reservation.rows[0]?.id;
        if (!reservationId) {
          const replay = await client.query<{
            request_fingerprint_hash: string;
            status: string;
            response_resource_id: string | null;
          }>(
            `SELECT request_fingerprint_hash, status, response_resource_id
             FROM platform.idempotency_keys
             WHERE operation_scope = 'identity' AND operation = $1 AND key_hash = $2
               AND tenant_scope = 'organization' AND organization_id = $3
             FOR UPDATE`,
            [staffStatusUpdateOperation, keyHash, normalized.organizationId],
          );
          await client.query("ROLLBACK");
          const row = replay.rows[0];
          return row?.request_fingerprint_hash === fingerprint &&
            row.status === "completed" &&
            row.response_resource_id === normalized.membershipId
            ? {
                outcome: "idempotent_replay" as const,
                membershipId: row.response_resource_id,
                membershipStatus: normalized.membershipStatus,
              }
            : { outcome: "rejected" as const, reason: "idempotency_conflict" as const };
        }
        const target = await client.query<StaffStatusTargetRow>(
          `SELECT membership.user_id::text, membership.status
           FROM identity.organization_memberships membership
           JOIN identity.users staff ON staff.id = membership.user_id
           WHERE membership.organization_id = $1 AND membership.id = $2
             AND membership.role_key = ANY($3::text[])
             AND membership.status IN ('active', 'suspended') AND staff.status = 'active'
           FOR UPDATE OF membership, staff`,
          [normalized.organizationId, normalized.membershipId, hotelStaffRoleKeys],
        );
        const previous = target.rows[0];
        if (!previous) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "target_not_found" as const };
        }
        if (
          !(await managerMayChangeMember(
            client,
            manager,
            normalized.organizationId,
            normalized.membershipId,
          ))
        ) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "inviter_not_authorized" as const };
        }
        await client.query(
          `UPDATE identity.organization_memberships
           SET status = $3, updated_at = now()
           WHERE organization_id = $1 AND id = $2`,
          [normalized.organizationId, normalized.membershipId, normalized.membershipStatus],
        );
        if (normalized.membershipStatus === "suspended")
          await enqueueInboxAssignmentReconciliation(client, {
            organizationId: normalized.organizationId,
            membershipId: normalized.membershipId,
            idempotencyId: reservationId,
            correlationId: command.audit.correlationId ?? command.audit.requestId,
            commandId: command.commandId,
            reason: "membership_suspended",
          });
        await client.query(
          `INSERT INTO platform.product_audit_events
             (audit_key, product, action, occurred_at, tenant_scope, organization_id,
              actor_type, actor_user_id, target_resource_product, target_resource_type,
              target_resource_id, idempotency_key_id, correlation_id, causation_id,
              redacted_payload, private_payload, audit_metadata, retention_class, privacy_scope)
           VALUES ($1, 'identity', 'identity.staff.status.updated', $2, 'organization', $3,
                   'user', $4, 'identity', 'organization_membership', $5, $6, $7, $8,
                   $9::jsonb, $10::jsonb, $11::jsonb, 'security', 'confidential')`,
          [
            `staff.status.updated:${reservationId}`,
            command.audit.requestedAt,
            normalized.organizationId,
            normalized.actorUserId,
            normalized.membershipId,
            reservationId,
            command.audit.correlationId ?? command.audit.requestId,
            command.commandId,
            JSON.stringify({ outcome: "updated", membershipStatus: normalized.membershipStatus }),
            JSON.stringify({
              targetUserId: previous.user_id,
              previous: { membershipStatus: previous.status },
              next: { membershipStatus: normalized.membershipStatus },
            }),
            JSON.stringify({
              requestId: command.audit.requestId,
              source: command.audit.source,
              reason: command.audit.reason,
              actorNameSnapshot: manager.name ?? manager.email,
            }),
          ],
        );
        const result = {
          outcome: "updated" as const,
          membershipId: normalized.membershipId,
          membershipStatus: normalized.membershipStatus,
        };
        const completed = await client.query(
          `UPDATE platform.idempotency_keys
           SET status = 'completed', response_status_code = 200, completed_at = now(),
               response_body_hash = $2, response_resource_product = 'identity',
               response_resource_type = 'organization_membership', response_resource_id = $3,
               idempotency_metadata = idempotency_metadata || jsonb_build_object('outcome', 'updated')
           WHERE id = $1 AND status = 'in_progress'`,
          [reservationId, hash(JSON.stringify(result)).toString("hex"), normalized.membershipId],
        );
        if (completed.rowCount !== 1) throw new Error("Staff status idempotency completion failed");
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async remove(command: RemoveStaffCommand) {
      const normalized = normalizeStaffRemoval(command);
      if (!normalized) return { outcome: "rejected" as const, reason: "invalid_command" as const };
      const keyHash = hash(command.idempotencyKey).toString("hex");
      const fingerprint = hash(JSON.stringify(normalized)).toString("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const manager = await lockAuthorizedManager(
          client,
          normalized.organizationId,
          normalized.actorUserId,
        );
        if (!manager) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "inviter_not_authorized" as const };
        }
        const reservation = await client.query<{ id: string }>(
          `INSERT INTO platform.idempotency_keys
             (operation_scope, operation, key_hash, request_fingerprint_hash, status,
              tenant_scope, organization_id, correlation_id, expires_at, idempotency_metadata)
           VALUES ('identity', $1, $2, $3, 'in_progress', 'organization', $4, $5,
                   now() + interval '30 days', jsonb_build_object('commandId', $6::text))
           ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
           RETURNING id::text AS id`,
          [
            staffRemovalOperation,
            keyHash,
            fingerprint,
            normalized.organizationId,
            command.audit.correlationId ?? command.audit.requestId,
            command.commandId,
          ],
        );
        const reservationId = reservation.rows[0]?.id;
        if (!reservationId) {
          const replay = await client.query<{
            request_fingerprint_hash: string;
            status: string;
            response_resource_id: string | null;
            provider_revocation_job_id: string | null;
          }>(
            `SELECT request_fingerprint_hash, status, response_resource_id,
                    idempotency_metadata ->> 'providerRevocationJobId' AS provider_revocation_job_id
             FROM platform.idempotency_keys
             WHERE operation_scope = 'identity' AND operation = $1 AND key_hash = $2
               AND tenant_scope = 'organization' AND organization_id = $3
             FOR UPDATE`,
            [staffRemovalOperation, keyHash, normalized.organizationId],
          );
          await client.query("ROLLBACK");
          const row = replay.rows[0];
          return row?.request_fingerprint_hash === fingerprint &&
            row.status === "completed" &&
            row.response_resource_id === normalized.membershipId &&
            row.provider_revocation_job_id
            ? {
                outcome: "idempotent_replay" as const,
                membershipId: row.response_resource_id,
                providerRevocationJobId: row.provider_revocation_job_id,
              }
            : { outcome: "rejected" as const, reason: "idempotency_conflict" as const };
        }
        const target = await client.query<StaffRemovalTargetRow>(
          `SELECT membership.user_id::text, membership.status,
                  NULLIF(btrim(membership.workos_membership_id), '') AS workos_membership_id,
                  NULLIF(btrim(organization.workos_org_id), '') AS workos_org_id,
                  ARRAY(SELECT btrim(external.provider_user_id)
                        FROM identity.external_identities external
                        WHERE external.user_id = staff.id AND external.provider = 'workos'
                          AND NULLIF(btrim(external.provider_user_id), '') IS NOT NULL
                        ORDER BY external.id) AS workos_user_ids
           FROM identity.organization_memberships membership
           JOIN identity.users staff ON staff.id = membership.user_id
           JOIN identity.organizations organization ON organization.id = membership.organization_id
           WHERE membership.organization_id = $1 AND membership.id = $2
             AND membership.role_key = ANY($3::text[])
             AND membership.status IN ('active', 'suspended')
             AND staff.status IN ('active', 'suspended')
           FOR UPDATE OF membership, staff, organization`,
          [normalized.organizationId, normalized.membershipId, hotelStaffRoleKeys],
        );
        const previous = target.rows[0];
        if (!previous) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "target_not_found" as const };
        }
        if (
          !(await managerMayChangeMember(
            client,
            manager,
            normalized.organizationId,
            normalized.membershipId,
          ))
        ) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "inviter_not_authorized" as const };
        }
        await client.query(
          `UPDATE identity.organization_memberships
           SET status = 'inactive', updated_at = now()
           WHERE organization_id = $1 AND id = $2`,
          [normalized.organizationId, normalized.membershipId],
        );
        await enqueueInboxAssignmentReconciliation(client, {
          organizationId: normalized.organizationId,
          membershipId: normalized.membershipId,
          idempotencyId: reservationId,
          correlationId: command.audit.correlationId ?? command.audit.requestId,
          commandId: command.commandId,
          reason: "membership_removed",
        });
        const expectedWorkosUserId =
          previous.workos_user_ids.length === 1 ? previous.workos_user_ids[0] : null;
        const job = await client.query<{ id: string }>(
          `INSERT INTO platform.jobs
             (job_key, queue_name, job_type, max_attempts, tenant_scope, organization_id,
              resource_product, resource_type, resource_id, correlation_id,
              idempotency_key_hash, payload, job_metadata)
           VALUES ($1, 'identity-provider', 'workos.organization-membership.delete', 5,
                   'organization', $2, 'identity', 'organization_membership', $3, $4, $5,
                   jsonb_strip_nulls(jsonb_build_object(
                     'workosMembershipId', $6::text,
                     'expectedWorkosOrganizationId', $7::text,
                     'expectedWorkosUserId', $8::text
                   )),
                   jsonb_build_object('commandId', $9::text, 'idempotencyKeyId', $10::text))
           RETURNING id::text AS id`,
          [
            `identity.staff.remove:${reservationId}`,
            normalized.organizationId,
            normalized.membershipId,
            command.audit.correlationId ?? command.audit.requestId,
            keyHash,
            previous.workos_membership_id,
            previous.workos_org_id,
            expectedWorkosUserId,
            command.commandId,
            reservationId,
          ],
        );
        const providerRevocationJobId = job.rows[0]?.id;
        if (!providerRevocationJobId) throw new Error("Staff removal job insert failed");
        await client.query(
          `INSERT INTO platform.product_audit_events
             (audit_key, product, action, occurred_at, tenant_scope, organization_id,
              actor_type, actor_user_id, target_resource_product, target_resource_type,
              target_resource_id, idempotency_key_id, job_id, correlation_id, causation_id,
              redacted_payload, private_payload, audit_metadata, retention_class, privacy_scope)
           VALUES ($1, 'identity', 'identity.staff.removed', $2, 'organization', $3,
                   'user', $4, 'identity', 'organization_membership', $5, $6, $7, $8, $9,
                   $10::jsonb, $11::jsonb, $12::jsonb, 'security', 'confidential')`,
          [
            `staff.removed:${reservationId}`,
            command.audit.requestedAt,
            normalized.organizationId,
            normalized.actorUserId,
            normalized.membershipId,
            reservationId,
            providerRevocationJobId,
            command.audit.correlationId ?? command.audit.requestId,
            command.commandId,
            JSON.stringify({
              outcome: "access_revoked",
              providerRevocation:
                previous.workos_membership_id && previous.workos_org_id && expectedWorkosUserId
                  ? "pending"
                  : "reconciliation_required",
            }),
            JSON.stringify({
              targetUserId: previous.user_id,
              previous: { membershipStatus: previous.status },
              next: { membershipStatus: "inactive" },
              providerRevocationJobId,
            }),
            JSON.stringify({
              requestId: command.audit.requestId,
              source: command.audit.source,
              reason: command.audit.reason,
              actorNameSnapshot: manager.name ?? manager.email,
            }),
          ],
        );
        const result = {
          outcome: "removed" as const,
          membershipId: normalized.membershipId,
          providerRevocationJobId,
        };
        const completed = await client.query(
          `UPDATE platform.idempotency_keys
           SET status = 'completed', response_status_code = 202, completed_at = now(),
               response_body_hash = $2, response_resource_product = 'identity',
               response_resource_type = 'organization_membership', response_resource_id = $3,
               idempotency_metadata = idempotency_metadata ||
                 jsonb_build_object('outcome', 'removed', 'providerRevocationJobId', $4::text)
           WHERE id = $1 AND status = 'in_progress'`,
          [
            reservationId,
            hash(JSON.stringify(result)).toString("hex"),
            normalized.membershipId,
            providerRevocationJobId,
          ],
        );
        if (completed.rowCount !== 1)
          throw new Error("Staff removal idempotency completion failed");
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async updateAccess(command: UpdateStaffAccessCommand) {
      const normalized = normalizeStaffAccessUpdate(command);
      if (!normalized) return { outcome: "rejected" as const, reason: "invalid_command" as const };
      const keyHash = hash(command.idempotencyKey).toString("hex");
      const fingerprint = hash(JSON.stringify(normalized)).toString("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const manager = await lockAuthorizedManager(
          client,
          normalized.organizationId,
          normalized.actorUserId,
        );
        if (!manager) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "inviter_not_authorized" as const };
        }
        const reservation = await client.query<{ id: string }>(
          `INSERT INTO platform.idempotency_keys
             (operation_scope, operation, key_hash, request_fingerprint_hash, status,
              tenant_scope, organization_id, correlation_id, expires_at, idempotency_metadata)
           VALUES ('identity', $1, $2, $3, 'in_progress', 'organization', $4, $5,
                   now() + interval '30 days', jsonb_build_object('commandId', $6::text))
           ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
           RETURNING id::text AS id`,
          [
            staffAccessUpdateOperation,
            keyHash,
            fingerprint,
            normalized.organizationId,
            command.audit.correlationId ?? command.audit.requestId,
            command.commandId,
          ],
        );
        const reservationId = reservation.rows[0]?.id;
        if (!reservationId) {
          const replay = await client.query<{
            request_fingerprint_hash: string;
            status: string;
            response_resource_id: string | null;
          }>(
            `SELECT request_fingerprint_hash, status, response_resource_id
             FROM platform.idempotency_keys
             WHERE operation_scope = 'identity' AND operation = $1 AND key_hash = $2
               AND tenant_scope = 'organization' AND organization_id = $3
             FOR UPDATE`,
            [staffAccessUpdateOperation, keyHash, normalized.organizationId],
          );
          await client.query("ROLLBACK");
          const row = replay.rows[0];
          return row?.request_fingerprint_hash === fingerprint &&
            row.status === "completed" &&
            row.response_resource_id === normalized.membershipId
            ? {
                outcome: "idempotent_replay" as const,
                membershipId: row.response_resource_id!,
              }
            : { outcome: "rejected" as const, reason: "idempotency_conflict" as const };
        }
        const target = await client.query<StaffAccessTargetRow>(
          `SELECT membership.id, membership.status, membership.access_origin,
                  membership.updated_at::text AS updated_at,
                  membership.pms_access_enabled, membership.booking_access_enabled,
                  membership.role_definition_id,
                  CASE WHEN definition.id IS NULL THEN NULL ELSE jsonb_build_object(
                    'id', definition.id, 'name', definition.name, 'revision', definition.revision::text,
                    'securityClass', definition.security_class, 'baseRoleKey', definition.base_role_key,
                    'presetKey', definition.preset_key, 'defaultPermissions', definition.default_permissions
                  ) END AS role_definition,
                  ARRAY(SELECT permission_key FROM identity.role_permission_grants
                        WHERE organization_kind = 'hotel_group'
                          AND role_key = membership.role_key ORDER BY permission_key) AS role_permissions,
                  membership.role_key, membership.permission_overrides,
                  membership.property_access_mode,
                  ARRAY(SELECT assignment.property_id::text
                        FROM identity.membership_property_assignments assignment
                        WHERE assignment.membership_id = membership.id
                        ORDER BY assignment.property_id) AS property_ids
           FROM identity.organization_memberships membership
           JOIN identity.users staff ON staff.id = membership.user_id
           LEFT JOIN identity.organization_roles definition
             ON definition.id = membership.role_definition_id AND definition.organization_id = membership.organization_id
           WHERE membership.organization_id = $1 AND membership.id = $2
             AND membership.role_key = ANY($3::text[])
             AND membership.status IN ('active', 'suspended')
             AND ($4::text IS NULL OR staff.status = 'active')
           FOR UPDATE OF membership, staff`,
          [
            normalized.organizationId,
            normalized.membershipId,
            hotelStaffRoleKeys,
            normalized.membershipStatus ?? null,
          ],
        );
        const previous = target.rows[0];
        if (!previous) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "target_not_found" as const };
        }
        if (
          (manager.role_key !== "hotel_owner" && normalized.expectedRevision === undefined) ||
          !(await managerMayChangeMember(
            client,
            manager,
            normalized.organizationId,
            normalized.membershipId,
          ))
        ) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "inviter_not_authorized" as const };
        }
        if (
          previous.role_key === "external_owner" &&
          normalized.roleKey !== "external_owner" &&
          (
            await client.query(
              "SELECT 1 FROM identity.membership_delegations WHERE organization_id = $1 AND delegator_membership_id = $2 LIMIT 1",
              [normalized.organizationId, normalized.membershipId],
            )
          ).rowCount
        ) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "invalid_command" as const };
        }
        if (previous.role_definition_id !== null && normalized.roleDefinitionId === undefined) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "invalid_command" as const };
        }
        if (
          normalized.expectedRevision !== undefined &&
          (previous.access_origin !== "agency" ||
            staffAccessRevision(previous) !== normalized.expectedRevision)
        ) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "revision_conflict" as const };
        }
        if (normalized.roleDefinitionId !== undefined) {
          if (
            manager.access_origin !== "agency" ||
            previous.access_origin !== "agency" ||
            (manager.role_key === "hotel_owner" &&
              (manager.property_access_mode !== "all" ||
                (manager.permission_overrides !== null &&
                  JSON.stringify(parseStaffPermissionOverrides(manager.permission_overrides)) !==
                    JSON.stringify({ grant: [], deny: [] }))))
          ) {
            await client.query("ROLLBACK");
            return { outcome: "rejected" as const, reason: "inviter_not_authorized" as const };
          }
          const role = await client.query<StaffRoleDefinition>(
            `SELECT id, name, revision::text, security_class AS "securityClass",
                    base_role_key AS "baseRoleKey", preset_key AS "presetKey",
                    default_permissions AS "defaultPermissions"
             FROM identity.organization_roles WHERE organization_id = $1 AND id = $2 FOR SHARE`,
            [normalized.organizationId, normalized.roleDefinitionId],
          );
          const definition = role.rows[0];
          if (
            !definition ||
            definition.baseRoleKey !== normalized.roleKey ||
            !resolveTeamRolePermissions(definition, normalized.permissionOverrides)
          ) {
            await client.query("ROLLBACK");
            return { outcome: "rejected" as const, reason: "invalid_command" as const };
          }
          if (definition.revision !== normalized.expectedRoleRevision) {
            await client.query("ROLLBACK");
            return { outcome: "rejected" as const, reason: "revision_conflict" as const };
          }
        }
        const linkedProperties = await client.query<{ property_id: string }>(
          `SELECT property.id::text AS property_id
           FROM identity.organization_resource_links link
           JOIN hotel_catalog.properties property ON property.id::text = link.resource_id
           WHERE link.organization_id = $1 AND link.product = 'hotel_catalog'
             AND link.resource_type = 'property' AND link.relationship IN ('owner', 'operator')
             AND link.status = 'active' AND property.id = ANY($2::uuid[])
           FOR SHARE OF link, property`,
          [normalized.organizationId, normalized.propertyIds],
        );
        if (
          new Set(linkedProperties.rows.map(({ property_id }) => property_id)).size !==
          normalized.propertyIds.length
        ) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "property_scope_invalid" as const };
        }
        await client.query(
          `UPDATE identity.organization_memberships
           SET role_key = $3, permission_overrides = $4::jsonb, role_definition_id = $9,
               property_access_mode = $8, status = COALESCE($5, status), updated_at = now(),
               pms_access_enabled = COALESCE($6, pms_access_enabled),
               booking_access_enabled = COALESCE($7, booking_access_enabled)
           WHERE organization_id = $1 AND id = $2`,
          [
            normalized.organizationId,
            normalized.membershipId,
            normalized.roleKey,
            JSON.stringify(normalized.permissionOverrides),
            normalized.membershipStatus ?? null,
            normalized.productAccess?.pms ?? null,
            normalized.productAccess?.booking ?? null,
            normalized.propertyAccessMode ?? "assigned",
            normalized.roleDefinitionId ?? null,
          ],
        );
        await client.query(
          "DELETE FROM identity.membership_property_assignments WHERE membership_id = $1",
          [normalized.membershipId],
        );
        await client.query(
          `INSERT INTO identity.membership_property_assignments (membership_id, property_id)
           SELECT $1, property_id FROM unnest($2::uuid[]) property_id`,
          [normalized.membershipId, normalized.propertyIds],
        );
        // Validate the complete proposed state inside this transaction before committing it.
        if (
          !(await managerMayChangeMember(
            client,
            manager,
            normalized.organizationId,
            normalized.membershipId,
          ))
        ) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "inviter_not_authorized" as const };
        }
        const nextPropertyIds = new Set(normalized.propertyIds);
        const previousOverrides =
          previous.permission_overrides === null
            ? { grant: [], deny: [] }
            : parseStaffPermissionOverrides(previous.permission_overrides);
        const permissionsChanged =
          (normalized.roleDefinitionId ?? null) !== previous.role_definition_id ||
          normalized.roleKey !== previous.role_key ||
          !previousOverrides ||
          (["grant", "deny"] as const).some(
            (key) =>
              JSON.stringify([...previousOverrides[key]].sort()) !==
              JSON.stringify(normalized.permissionOverrides[key]),
          );
        const propertyAccessRemoved =
          normalized.propertyAccessMode !== "all" &&
          (previous.property_access_mode === "all" ||
            previous.property_ids.some((propertyId) => !nextPropertyIds.has(propertyId)));
        if (
          permissionsChanged ||
          normalized.membershipStatus === "suspended" ||
          normalized.productAccess?.pms === false ||
          propertyAccessRemoved
        )
          await enqueueInboxAssignmentReconciliation(client, {
            organizationId: normalized.organizationId,
            membershipId: normalized.membershipId,
            idempotencyId: reservationId,
            correlationId: command.audit.correlationId ?? command.audit.requestId,
            commandId: command.commandId,
            reason:
              normalized.membershipStatus === "suspended"
                ? "membership_suspended"
                : normalized.productAccess?.pms === false
                  ? "product_access_removed"
                  : propertyAccessRemoved
                    ? "property_access_removed"
                    : "role_permissions_changed",
          });
        const next = {
          roleDefinitionId: normalized.roleDefinitionId ?? null,
          propertyAccessMode: normalized.propertyAccessMode ?? "assigned",
          productAccess: normalized.productAccess ?? {
            pms: previous.pms_access_enabled,
            booking: previous.booking_access_enabled,
          },
          membershipStatus: normalized.membershipStatus ?? previous.status,
          roleKey: normalized.roleKey,
          permissionOverrides: normalized.permissionOverrides,
          propertyIds: normalized.propertyIds,
        };
        await client.query(
          `INSERT INTO platform.product_audit_events
             (audit_key, product, action, occurred_at, tenant_scope, organization_id,
              actor_type, actor_user_id, target_resource_product, target_resource_type,
              target_resource_id, idempotency_key_id, correlation_id, causation_id,
              redacted_payload, private_payload, audit_metadata, retention_class, privacy_scope)
           VALUES ($1, 'identity', 'identity.staff.access.updated', now(), 'organization', $2,
                   'user', $3, 'identity', 'organization_membership', $4, $5, $6, $7,
                   $8::jsonb, $9::jsonb, $10::jsonb, 'security', 'confidential')`,
          [
            `staff.access.updated:${reservationId}`,
            normalized.organizationId,
            normalized.actorUserId,
            normalized.membershipId,
            reservationId,
            command.audit.correlationId ?? command.audit.requestId,
            command.commandId,
            JSON.stringify({
              outcome: "updated",
              membershipStatus: normalized.membershipStatus ?? previous.status,
              roleKey: normalized.roleKey,
              propertyCount: normalized.propertyIds.length,
              permissionGrantCount: normalized.permissionOverrides.grant.length,
              permissionDenyCount: normalized.permissionOverrides.deny.length,
            }),
            JSON.stringify({
              previous: {
                roleDefinitionId: previous.role_definition_id,
                propertyAccessMode: previous.property_access_mode,
                productAccess: {
                  pms: previous.pms_access_enabled,
                  booking: previous.booking_access_enabled,
                },
                membershipStatus: previous.status,
                roleKey: previous.role_key,
                permissionOverrides: previous.permission_overrides,
                propertyIds: previous.property_ids,
              },
              next,
            }),
            JSON.stringify({
              requestId: command.audit.requestId,
              source: command.audit.source,
              reason: command.audit.reason,
              requestedAt: command.audit.requestedAt,
              actorNameSnapshot: manager.name ?? manager.email,
            }),
          ],
        );
        const result = { outcome: "updated" as const, membershipId: normalized.membershipId };
        const completed = await client.query(
          `UPDATE platform.idempotency_keys
           SET status = 'completed', response_status_code = 200, completed_at = now(),
               response_body_hash = $2, response_resource_product = 'identity',
               response_resource_type = 'organization_membership', response_resource_id = $3,
               idempotency_metadata = idempotency_metadata || jsonb_build_object('outcome', 'updated')
           WHERE id = $1 AND status = 'in_progress'`,
          [reservationId, hash(JSON.stringify(result)).toString("hex"), normalized.membershipId],
        );
        if (completed.rowCount !== 1) throw new Error("Staff access idempotency completion failed");
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (isPropertyScopeError(error)) {
          return { outcome: "rejected" as const, reason: "property_scope_invalid" as const };
        }
        throw error;
      } finally {
        client.release();
      }
    },
    async persist(command: CreateStaffInviteCommand) {
      const normalized = normalize(command);
      if (!normalized) return { outcome: "rejected" as const, reason: "invalid_command" as const };
      const keyHash = hash(command.idempotencyKey);
      const fingerprint = hash(JSON.stringify(normalized));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inviterRow = await lockAuthorizedManager(
          client,
          normalized.organizationId,
          normalized.actorUserId,
        );
        if (!inviterRow) {
          await client.query("ROLLBACK");
          return {
            outcome: "rejected" as const,
            reason: "inviter_not_authorized" as const,
          };
        }

        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          keyHash.toString("hex"),
        ]);
        const replay = await client.query<InvitationRow>(
          `SELECT id, request_fingerprint_hash, supersedes_invitation_id FROM identity.staff_invitations
           WHERE idempotency_key_hash = $1
           FOR UPDATE`,
          [keyHash],
        );
        const replayRow = replay.rows[0];
        if (replayRow) {
          await client.query("ROLLBACK");
          if (!replayRow.request_fingerprint_hash.equals(fingerprint)) {
            return { outcome: "rejected" as const, reason: "idempotency_conflict" as const };
          }
          return {
            outcome: "idempotent_replay" as const,
            invitationId: replayRow.id,
            ...(replayRow.supersedes_invitation_id
              ? { supersededInvitationId: replayRow.supersedes_invitation_id }
              : {}),
          };
        }

        const revision = await client.query<{ id: string }>(
          `SELECT id FROM identity.staff_invitations WHERE organization_id = $1 AND email = $2
             AND configuration_revision = $3`,
          [normalized.organizationId, normalized.email, normalized.configurationRevision],
        );
        if (revision.rowCount) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "configuration_conflict" as const };
        }
        if (normalized.expectedInvitationId !== undefined) {
          const current = await client.query<{ id: string; configuration_revision: number }>(
            `SELECT id, configuration_revision FROM identity.staff_invitations
             WHERE organization_id = $1 AND email = $2 AND status = 'pending' FOR UPDATE`,
            [normalized.organizationId, normalized.email],
          );
          if (
            current.rows[0]?.id !== normalized.expectedInvitationId ||
            normalized.configurationRevision !== current.rows[0].configuration_revision + 1
          ) {
            await client.query("ROLLBACK");
            return { outcome: "rejected" as const, reason: "configuration_conflict" as const };
          }
        }

        if (normalized.roleDefinitionId !== undefined) {
          const overrides =
            inviterRow.permission_overrides === null
              ? { grant: [], deny: [] }
              : parseStaffPermissionOverrides(inviterRow.permission_overrides);
          if (
            inviterRow.access_origin !== "agency" ||
            (inviterRow.role_key === "hotel_owner" &&
              (inviterRow.property_access_mode !== "all" ||
                !overrides ||
                overrides.grant.length ||
                overrides.deny.length))
          ) {
            await client.query("ROLLBACK");
            return { outcome: "rejected" as const, reason: "inviter_not_authorized" as const };
          }
          const role = await client.query<StaffRoleDefinition>(
            `SELECT id, name, revision::text, security_class AS "securityClass",
                    base_role_key AS "baseRoleKey", preset_key AS "presetKey", default_permissions AS "defaultPermissions"
             FROM identity.organization_roles WHERE organization_id = $1 AND id = $2 FOR SHARE`,
            [normalized.organizationId, normalized.roleDefinitionId],
          );
          const definition = role.rows[0];
          if (
            !definition ||
            definition.baseRoleKey !== normalized.roleKey ||
            !resolveTeamRolePermissions(definition, normalized.permissionOverrides)
          ) {
            await client.query("ROLLBACK");
            return { outcome: "rejected" as const, reason: "invalid_command" as const };
          }
          if (definition.revision !== normalized.expectedRoleRevision) {
            await client.query("ROLLBACK");
            return { outcome: "rejected" as const, reason: "configuration_conflict" as const };
          }
        }

        if (inviterRow.role_key !== "hotel_owner") {
          const existing = await client.query<{ id: string; source: "membership" | "invitation" }>(
            `SELECT member.id, 'membership' AS source FROM identity.organization_memberships member
             JOIN identity.users person ON person.id = member.user_id
             WHERE member.organization_id = $1 AND lower(person.email) = $2
             UNION ALL SELECT id, 'invitation' FROM identity.staff_invitations
             WHERE organization_id = $1 AND email = $2 AND status = 'pending'`,
            [normalized.organizationId, normalized.email],
          );
          for (const target of existing.rows) {
            if (
              !(await managerMayChangeMember(
                client,
                inviterRow,
                normalized.organizationId,
                target.id,
                target.source,
              ))
            ) {
              await client.query("ROLLBACK");
              return { outcome: "rejected" as const, reason: "inviter_not_authorized" as const };
            }
          }
        }
        const previous = await client.query<{ id: string; status: string }>(
          `UPDATE identity.staff_invitations
           SET status = CASE WHEN expires_at <= now() THEN 'expired' ELSE 'revoked' END, updated_at = now()
           WHERE organization_id = $1 AND email = $2 AND status = 'pending'
           RETURNING id, status`,
          [normalized.organizationId, normalized.email],
        );
        const previousRow = previous.rows[0];
        const supersededId = previousRow?.status === "revoked" ? previousRow.id : null;
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO identity.staff_invitations
             (organization_id, email, display_name, inviter_membership_id, inviter_user_id, inviter_name_snapshot,
              role_key, permission_overrides, property_access_mode, configuration_revision, command_id,
              idempotency_key_hash, request_fingerprint_hash, supersedes_invitation_id, request_id,
              correlation_id, request_source, reason, requested_at, pms_access_enabled, booking_access_enabled, role_definition_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $21, $9, $10, $11, $12,
                   $13, $14, $15, $16, $17, $18, $19, $20, $22)
           RETURNING id`,
          [
            normalized.organizationId,
            normalized.email,
            normalized.name,
            inviterRow.membership_id,
            normalized.actorUserId,
            inviterRow.name ?? inviterRow.email,
            normalized.roleKey,
            JSON.stringify(normalized.permissionOverrides),
            normalized.configurationRevision,
            command.commandId,
            keyHash,
            fingerprint,
            supersededId,
            command.audit.requestId,
            command.audit.correlationId ?? null,
            command.audit.source,
            command.audit.reason,
            new Date(command.audit.requestedAt),
            normalized.productAccess?.pms ?? true,
            normalized.productAccess?.booking ?? true,
            normalized.propertyAccessMode ?? "assigned",
            normalized.roleDefinitionId ?? null,
          ],
        );
        const invitationId = inserted.rows[0]!.id;
        await client.query(
          `INSERT INTO identity.staff_invitation_property_assignments (invitation_id, property_id)
             SELECT $1, property_id FROM unnest($2::uuid[]) property_id`,
          [invitationId, normalized.propertyIds],
        );
        if (
          !(await managerMayChangeMember(
            client,
            inviterRow,
            normalized.organizationId,
            invitationId,
            "invitation",
          ))
        ) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "inviter_not_authorized" as const };
        }
        await client.query("COMMIT");
        return {
          outcome: "created" as const,
          invitationId,
          ...(supersededId ? { supersededInvitationId: supersededId } : {}),
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (isPropertyScopeError(error)) {
          return { outcome: "rejected" as const, reason: "property_scope_invalid" as const };
        }
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function enqueueInboxAssignmentReconciliation(
  client: pg.PoolClient,
  input: {
    organizationId: string;
    membershipId: string;
    idempotencyId: string;
    correlationId: string;
    commandId: string;
    reason:
      | "membership_removed"
      | "membership_suspended"
      | "property_access_removed"
      | "product_access_removed"
      | "role_permissions_changed";
  },
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO platform.jobs
       (job_key, queue_name, job_type, max_attempts, tenant_scope, organization_id,
        resource_product, resource_type, resource_id, correlation_id, payload, job_metadata)
     VALUES ($1, 'pms-inbox', $2, 5, 'organization', $3, 'pms', 'inbox_assignment',
             $4, $5, jsonb_build_object('membershipId', $4::text),
             jsonb_build_object('identityIdempotencyKeyId', $6::text,
                                'commandId', $7::text, 'reason', $8::text))
     ON CONFLICT DO NOTHING`,
    [
      `${inboxAssignmentReconciliationJobType}:${input.idempotencyId}:${input.membershipId}`,
      inboxAssignmentReconciliationJobType,
      input.organizationId,
      input.membershipId,
      input.correlationId,
      input.idempotencyId,
      input.commandId,
      input.reason,
    ],
  );
  if (inserted.rowCount !== 1)
    throw new Error("PMS Inbox assignment reconciliation job was not scheduled");
}

function normalize(command: CreateStaffInviteCommand) {
  const actor = command.audit.actor;
  if (
    actor.kind !== "user" ||
    actor.organizationId !== command.payload.organizationId ||
    !actor.userId ||
    !command.commandId.trim() ||
    !command.idempotencyKey.trim() ||
    !command.payload.email.trim() ||
    (command.payload.expectedInvitationId !== undefined &&
      !canonicalUuid(command.payload.expectedInvitationId)) ||
    !Number.isInteger(command.payload.configurationRevision) ||
    command.payload.configurationRevision <= 0 ||
    (command.payload.productAccess !== undefined &&
      !validProductAccess(command.payload.productAccess)) ||
    Number.isNaN(Date.parse(command.audit.requestedAt)) ||
    ((command.payload.roleDefinitionId !== undefined ||
      command.payload.expectedRoleRevision !== undefined) &&
      (!canonicalUuid(command.payload.roleDefinitionId ?? "") ||
        !/^[1-9][0-9]*$/.test(command.payload.expectedRoleRevision ?? ""))) ||
    (command.payload.roleKey === "external_owner" &&
      command.payload.roleDefinitionId === undefined) ||
    validateStaffInviteAccess(command.payload).filter(
      (issue) =>
        command.payload.roleDefinitionId === undefined || issue !== "missing_required_permission",
    ).length
  ) {
    return null;
  }
  const propertyIds = command.payload.propertyIds.map((id) => id.toLowerCase()).sort();
  const permissionOverrides = {
    grant: [...command.payload.permissionOverrides.grant].sort(),
    deny: [...command.payload.permissionOverrides.deny].sort(),
  };
  return {
    organizationId: command.payload.organizationId,
    email: command.payload.email.trim().toLowerCase(),
    name: command.payload.name?.trim() || null,
    roleKey: command.payload.roleKey,
    propertyIds,
    permissionOverrides,
    configurationRevision: command.payload.configurationRevision,
    ...(command.payload.expectedInvitationId === undefined
      ? {}
      : { expectedInvitationId: command.payload.expectedInvitationId.toLowerCase() }),
    ...(command.payload.roleDefinitionId === undefined
      ? {}
      : {
          roleDefinitionId: command.payload.roleDefinitionId.toLowerCase(),
          expectedRoleRevision: command.payload.expectedRoleRevision!,
        }),
    ...(command.payload.propertyAccessMode === "all" ? { propertyAccessMode: "all" as const } : {}),
    ...(command.payload.productAccess === undefined
      ? {}
      : {
          productAccess: {
            pms: command.payload.productAccess.pms,
            booking: command.payload.productAccess.booking,
          },
        }),
    actorUserId: actor.userId,
  };
}

function normalizeStaffAccessUpdate(command: UpdateStaffAccessCommand) {
  const actor = command.audit.actor;
  if (
    actor.kind !== "user" ||
    actor.organizationId !== command.payload.organizationId ||
    !actor.userId ||
    !command.commandId.trim() ||
    !command.idempotencyKey.trim() ||
    !canonicalUuid(command.payload.membershipId) ||
    Number.isNaN(Date.parse(command.audit.requestedAt)) ||
    (command.payload.expectedRevision !== undefined &&
      !/^[a-f0-9]{64}$/.test(command.payload.expectedRevision)) ||
    (command.payload.membershipStatus !== undefined &&
      (command.payload.expectedRevision === undefined ||
        !["active", "suspended"].includes(command.payload.membershipStatus))) ||
    (command.payload.productAccess !== undefined &&
      (command.payload.expectedRevision === undefined ||
        !validProductAccess(command.payload.productAccess))) ||
    (command.payload.propertyAccessMode === "all" &&
      command.payload.expectedRevision === undefined) ||
    ((command.payload.roleDefinitionId !== undefined ||
      command.payload.expectedRoleRevision !== undefined) &&
      (!canonicalUuid(command.payload.roleDefinitionId ?? "") ||
        !/^[1-9][0-9]*$/.test(command.payload.expectedRoleRevision ?? "") ||
        command.payload.expectedRevision === undefined)) ||
    (command.payload.roleKey === "external_owner" &&
      command.payload.roleDefinitionId === undefined) ||
    validateStaffInviteAccess(command.payload).filter(
      (issue) =>
        // Referenced-role hierarchy is checked against locked saved defaults below.
        command.payload.roleDefinitionId === undefined || issue !== "missing_required_permission",
    ).length
  ) {
    return null;
  }
  return {
    organizationId: command.payload.organizationId,
    membershipId: command.payload.membershipId.toLowerCase(),
    ...(command.payload.propertyAccessMode === "all" ? { propertyAccessMode: "all" as const } : {}),
    roleKey: command.payload.roleKey,
    ...(command.payload.roleDefinitionId === undefined
      ? {}
      : {
          roleDefinitionId: command.payload.roleDefinitionId.toLowerCase(),
          expectedRoleRevision: command.payload.expectedRoleRevision!,
        }),
    propertyIds: command.payload.propertyIds.map((id) => id.toLowerCase()).sort(),
    permissionOverrides: {
      grant: [...command.payload.permissionOverrides.grant].sort(),
      deny: [...command.payload.permissionOverrides.deny].sort(),
    },
    actorUserId: actor.userId,
    ...(command.payload.productAccess === undefined
      ? {}
      : {
          productAccess: {
            pms: command.payload.productAccess.pms,
            booking: command.payload.productAccess.booking,
          },
        }),
    ...(command.payload.expectedRevision === undefined
      ? {}
      : { expectedRevision: command.payload.expectedRevision }),
    ...(command.payload.membershipStatus === undefined
      ? {}
      : { membershipStatus: command.payload.membershipStatus }),
  };
}

function normalizeStaffStatusUpdate(command: UpdateStaffStatusCommand) {
  const actor = command.audit.actor;
  if (
    actor.kind !== "user" ||
    actor.organizationId !== command.payload.organizationId ||
    !actor.userId ||
    !command.commandId.trim() ||
    !command.idempotencyKey.trim() ||
    !canonicalUuid(command.payload.membershipId) ||
    !["active", "suspended"].includes(command.payload.membershipStatus) ||
    Number.isNaN(Date.parse(command.audit.requestedAt))
  ) {
    return null;
  }
  return {
    organizationId: command.payload.organizationId,
    membershipId: command.payload.membershipId.toLowerCase(),
    membershipStatus: command.payload.membershipStatus,
    actorUserId: actor.userId,
  };
}

function normalizeStaffRemoval(command: RemoveStaffCommand) {
  const actor = command.audit.actor;
  if (
    actor.kind !== "user" ||
    actor.organizationId !== command.payload.organizationId ||
    !actor.userId ||
    !command.commandId.trim() ||
    !command.idempotencyKey.trim() ||
    !canonicalUuid(command.payload.membershipId) ||
    Number.isNaN(Date.parse(command.audit.requestedAt))
  ) {
    return null;
  }
  return {
    organizationId: command.payload.organizationId,
    membershipId: command.payload.membershipId.toLowerCase(),
    actorUserId: actor.userId,
  };
}

async function lockAuthorizedManager(
  client: pg.PoolClient,
  organizationId: string,
  actorUserId: string,
): Promise<InviterRow | null> {
  // Invitation acceptance already holds this lock; use the same order in every writer.
  const organization = await client.query(
    "SELECT id FROM identity.organizations WHERE id = $1 AND kind = 'hotel_group' AND status = 'active' FOR UPDATE",
    [organizationId],
  );
  if (!organization.rowCount) return null;
  const result = await client.query<InviterRow>(
    `SELECT membership.id AS membership_id, membership.role_key, actor.name, actor.email, membership.permission_overrides,
            membership.access_origin, membership.property_access_mode, membership.role_definition_id,
            CASE WHEN definition.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id', definition.id, 'name', definition.name, 'revision', definition.revision::text,
              'securityClass', definition.security_class, 'baseRoleKey', definition.base_role_key,
              'presetKey', definition.preset_key, 'defaultPermissions', definition.default_permissions
            ) END AS role_definition,
            ARRAY(SELECT grant_row.permission_key FROM identity.role_permission_grants grant_row
                  WHERE grant_row.organization_kind = organization.kind
                    AND grant_row.role_key = membership.role_key) AS role_permissions
     FROM identity.organization_memberships membership
     JOIN identity.organizations organization ON organization.id = membership.organization_id
     JOIN identity.users actor ON actor.id = membership.user_id
     LEFT JOIN identity.organization_roles definition
       ON definition.id = membership.role_definition_id AND definition.organization_id = membership.organization_id
     WHERE membership.organization_id = $1 AND membership.user_id = $2
       AND membership.status = 'active' AND organization.kind = 'hotel_group'
       AND organization.status = 'active' AND actor.status = 'active'
     FOR UPDATE OF membership, organization, actor`,
    [organizationId, actorUserId],
  );
  const row = result.rows[0];
  return row && hasStaffManage(row) ? row : null;
}

async function managerMayChangeMember(
  client: pg.PoolClient,
  manager: InviterRow,
  organizationId: string,
  membershipId: string,
  source: "membership" | "invitation" = "membership",
): Promise<boolean> {
  if (manager.role_key === "hotel_owner") return true;
  const actor = await loadManagedStaffAccess(client, organizationId, manager.membership_id);
  const target = await loadManagedStaffAccess(client, organizationId, membershipId, source);
  return Boolean(actor && target && withinStaffManagementScope(actor, target));
}

export async function authorizeStaffInvitationAcceptance(
  client: pg.PoolClient,
  organizationId: string,
  inviterUserId: string,
  recipientUserId: string,
  invitationId: string,
): Promise<boolean> {
  const manager = await lockAuthorizedManager(client, organizationId, inviterUserId);
  if (
    !manager ||
    !(await managerMayChangeMember(client, manager, organizationId, invitationId, "invitation"))
  )
    return false;
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM identity.organization_memberships WHERE organization_id = $1 AND user_id = $2",
    [organizationId, recipientUserId],
  );
  return (
    !existing.rows[0] ||
    managerMayChangeMember(client, manager, organizationId, existing.rows[0].id)
  );
}

function hasStaffManage(row: InviterRow): boolean {
  if (row.role_definition_id !== null) {
    const role = row.role_definition;
    if (!role || role.id !== row.role_definition_id || role.baseRoleKey !== row.role_key)
      return false;
    return (
      resolveTeamRolePermissions(
        role,
        row.permission_overrides ?? { grant: [], deny: [] },
        row.role_permissions.filter((key): key is PermissionKey => permissionKeys.has(key)),
      )?.includes("identity.staff.manage") ?? false
    );
  }
  if (row.permission_overrides === null) {
    return row.role_permissions.includes("identity.staff.manage");
  }
  if (
    !row.permission_overrides ||
    typeof row.permission_overrides !== "object" ||
    Array.isArray(row.permission_overrides)
  )
    return false;
  const value = row.permission_overrides as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "grant" && key !== "deny")) return false;
  const grant = value["grant"] ?? [];
  const deny = value["deny"] ?? [];
  if (!validPermissionList(grant) || !validPermissionList(deny)) return false;
  const combined = [...grant, ...deny];
  if (new Set(combined).size !== combined.length || grant.includes("identity.staff.manage")) {
    return false;
  }
  const effective = new Set(row.role_permissions);
  grant.forEach((key) => effective.add(key));
  deny.forEach((key) => effective.delete(key));
  return effective.has("identity.staff.manage") && hasValidStaffPermissionHierarchy(effective);
}

function validPermissionList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((key) => typeof key === "string" && permissionKeys.has(key))
  );
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function canonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPropertyScopeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; constraint?: string };
  return (
    value.code === "23503" &&
    [
      "fk_staff_invitation_property_assignment_canonical_scope",
      "staff_invitation_property_assignments_property_id_fkey",
      "fk_membership_property_assignment_canonical_scope",
      "membership_property_assignments_property_id_fkey",
    ].includes(value.constraint ?? "")
  );
}

function resolveSavedStaffPermissions(
  row: StaffAccessTargetRow,
  overrides: { grant: string[]; deny: string[] } | null,
): string[] | null {
  if (!overrides) return null;
  if (row.role_definition_id !== null) {
    const role = row.role_definition;
    if (!role || role.id !== row.role_definition_id || role.baseRoleKey !== row.role_key)
      return null;
    return resolveTeamRolePermissions(role, overrides);
  }
  if (
    validateStaffPermissionOverrides({
      roleKey: row.role_key,
      rolePermissions: row.role_permissions,
      permissionOverrides: overrides,
    }).length
  )
    return null;
  const effective = new Set(row.role_permissions);
  overrides.grant.forEach((key) => effective.add(key));
  overrides.deny.forEach((key) => effective.delete(key));
  return [...effective].sort();
}

export function validProductAccess(value: unknown): value is { pms: boolean; booking: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    "pms" in value &&
    "booking" in value &&
    typeof value.pms === "boolean" &&
    typeof value.booking === "boolean"
  );
}
