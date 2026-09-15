import { createHash } from "node:crypto";
import type pg from "pg";
import type { IdentityCommandAudit } from "./lifecycle.js";
import { enqueueInboxAssignmentReconciliation } from "./staffInvitations.js";
import {
  resolveTeamRolePermissions,
  validateTeamRoleDefaults,
  type TeamRolePolicy,
} from "./teamRolePolicy.js";

export type TeamRoleCreateCommand = {
  commandId: string;
  idempotencyKey: string;
  audit: IdentityCommandAudit;
  payload: {
    organizationId: string;
    name: string;
    description: string;
    defaultPermissions: readonly string[];
    sourceRoleId?: string;
  };
};

export type TeamRoleChangeCommand = Omit<TeamRoleCreateCommand, "payload"> & {
  payload: { organizationId: string; roleId: string; expectedRevision: string } & (
    | {
        operation: "update";
        name: string;
        description: string;
        defaultPermissions: readonly string[];
      }
    | { operation: "delete" }
  );
};

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export async function runTeamRoleCommand(
  pool: pg.Pool,
  command: TeamRoleCreateCommand | TeamRoleChangeCommand,
) {
  const input =
      "operation" in command.payload
        ? command.payload
        : { ...command.payload, operation: "create" as const },
    actor = command.audit.actor;
  if (
    actor.kind !== "user" ||
    !["create", "update", "delete"].includes(input.operation) ||
    actor.organizationId !== input.organizationId ||
    !uuid(actor.userId) ||
    !uuid(input.organizationId) ||
    (input.operation === "create" &&
      input.sourceRoleId !== undefined &&
      !uuid(input.sourceRoleId)) ||
    (input.operation !== "create" &&
      (!uuid(input.roleId) ||
        typeof input.expectedRevision !== "string" ||
        !/^[1-9][0-9]*$/.test(input.expectedRevision))) ||
    (input.operation !== "delete" &&
      (typeof input.name !== "string" ||
        input.name.trim().length < 1 ||
        input.name.trim().length > 80 ||
        typeof input.description !== "string" ||
        input.description.length > 1000 ||
        !Array.isArray(input.defaultPermissions) ||
        !input.defaultPermissions.every((key) => typeof key === "string"))) ||
    typeof command.idempotencyKey !== "string" ||
    !command.idempotencyKey.trim() ||
    typeof command.commandId !== "string" ||
    !command.commandId.trim()
  ) {
    return { outcome: "rejected" as const, reason: "invalid_command" as const };
  }
  const normalized = {
    organizationId: input.organizationId.toLowerCase(),
    actorUserId: actor.userId.toLowerCase(),
    name: input.operation === "delete" ? null : input.name.trim(),
    description: input.operation === "delete" ? null : input.description,
    defaultPermissions: input.operation === "delete" ? null : [...input.defaultPermissions].sort(),
    sourceRoleId:
      input.operation === "create"
        ? (input.sourceRoleId?.toLowerCase() ?? null)
        : input.roleId.toLowerCase(),
    ...(input.operation === "create"
      ? {}
      : { operation: input.operation, expectedRevision: input.expectedRevision }),
  };
  const fingerprint = hash(JSON.stringify(normalized)),
    keyHash = hash(command.idempotencyKey);
  const operation = `team_role_${input.operation}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const admin = await client.query(
      `SELECT member.id
      FROM identity.organizations organization
      JOIN identity.organization_memberships member ON member.organization_id = organization.id
      JOIN identity.users actor ON actor.id = member.user_id
      WHERE organization.id = $1 AND organization.kind = 'hotel_group' AND organization.status = 'active'
        AND member.user_id = $2 AND member.status = 'active' AND actor.status = 'active'
        AND member.role_key = 'hotel_owner' AND member.access_origin = 'agency' AND member.property_access_mode = 'all'
        AND (member.permission_overrides IS NULL OR member.permission_overrides = '{"grant":[],"deny":[]}'::jsonb)
        AND EXISTS (SELECT 1 FROM identity.role_permission_grants grant_row WHERE grant_row.organization_kind = 'hotel_group' AND grant_row.role_key = 'hotel_owner' AND grant_row.permission_key = 'identity.staff.manage')
        AND (member.role_definition_id IS NULL OR EXISTS (
          SELECT 1 FROM identity.organization_roles definition WHERE definition.id = member.role_definition_id AND definition.organization_id = organization.id
            AND definition.security_class = 'account_admin' AND definition.base_role_key = 'hotel_owner' AND definition.preset_key = 'account_admin' AND definition.default_permissions = '[]'::jsonb))
      FOR UPDATE OF organization, member, actor`,
      [normalized.organizationId, normalized.actorUserId],
    );
    if (!admin.rowCount) {
      await client.query("ROLLBACK");
      return { outcome: "rejected" as const, reason: "forbidden" as const };
    }
    const reservation = await client.query<{ id: string }>(
      `INSERT INTO platform.idempotency_keys
      (operation_scope, operation, key_hash, request_fingerprint_hash, status, tenant_scope, organization_id, correlation_id, expires_at)
      VALUES ('identity', $5, $1, $2, 'in_progress', 'organization', $3, $4, now() + interval '30 days')
      ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING RETURNING id`,
      [
        keyHash,
        fingerprint,
        normalized.organizationId,
        command.audit.correlationId ?? command.audit.requestId,
        operation,
      ],
    );
    const reservationId = reservation.rows[0]?.id;
    if (!reservationId) {
      const replay = await client.query<{
        request_fingerprint_hash: string;
        status: string;
        response_resource_id: string | null;
      }>(
        `SELECT request_fingerprint_hash, status, response_resource_id FROM platform.idempotency_keys
        WHERE operation_scope = 'identity' AND operation = $3 AND key_hash = $1 AND organization_id = $2 FOR UPDATE`,
        [keyHash, normalized.organizationId, operation],
      );
      await client.query("ROLLBACK");
      const row = replay.rows[0];
      return row?.request_fingerprint_hash === fingerprint &&
        row.status === "completed" &&
        row.response_resource_id
        ? { outcome: "idempotent_replay" as const, roleId: row.response_resource_id }
        : { outcome: "rejected" as const, reason: "idempotency_conflict" as const };
    }
    let policy: TeamRolePolicy = {
      securityClass: "staff",
      baseRoleKey: "hotel_custom",
      presetKey: null,
      defaultPermissions: normalized.defaultPermissions,
    };
    let previous: unknown = null;
    let previousPolicy: TeamRolePolicy | undefined;
    if (normalized.sourceRoleId) {
      const source = await client.query<{
        security_class: TeamRolePolicy["securityClass"];
        base_role_key: string;
        preset_key: string | null;
        default_permissions: unknown;
        revision: string;
        name: string;
        description: string;
      }>(
        `SELECT security_class, base_role_key, preset_key, default_permissions, revision::text, name, description FROM identity.organization_roles WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [normalized.sourceRoleId, normalized.organizationId],
      );
      const row = source.rows[0];
      if (
        !row ||
        row.security_class === "account_admin" ||
        !validateTeamRoleDefaults({
          securityClass: row.security_class,
          baseRoleKey: row.base_role_key,
          presetKey: row.preset_key,
          defaultPermissions: row.default_permissions,
        })
      ) {
        await client.query("ROLLBACK");
        return { outcome: "rejected" as const, reason: "invalid_source_role" as const };
      }
      if (input.operation !== "create" && row.revision !== input.expectedRevision) {
        await client.query("ROLLBACK");
        return { outcome: "rejected" as const, reason: "stale_revision" as const };
      }
      previous = row;
      previousPolicy = {
        securityClass: row.security_class,
        baseRoleKey: row.base_role_key,
        presetKey: row.preset_key,
        defaultPermissions: row.default_permissions,
      };
      policy = {
        ...policy,
        securityClass: row.security_class,
        baseRoleKey: row.base_role_key,
        presetKey: input.operation === "create" ? null : row.preset_key,
        defaultPermissions:
          input.operation === "delete" ? row.default_permissions : normalized.defaultPermissions,
      };
    }
    if (!validateTeamRoleDefaults(policy)) {
      await client.query("ROLLBACK");
      return { outcome: "rejected" as const, reason: "invalid_permissions" as const };
    }
    let roleId = normalized.sourceRoleId;
    if (input.operation === "create") {
      const created = await client.query<{ id: string }>(
        `INSERT INTO identity.organization_roles
      (organization_id, name, description, security_class, base_role_key, default_permissions)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
        [
          normalized.organizationId,
          normalized.name,
          normalized.description,
          policy.securityClass,
          policy.baseRoleKey,
          JSON.stringify(policy.defaultPermissions),
        ],
      );
      roleId = created.rows[0]!.id;
    } else {
      const references = await client.query<{
        member_id: string | null;
        role_key: string;
        permission_overrides: unknown;
      }>(
        `SELECT id::text AS member_id, role_key, permission_overrides FROM identity.organization_memberships WHERE organization_id = $1 AND role_definition_id = $2 AND status <> 'inactive'
        UNION ALL SELECT NULL, role_key, permission_overrides FROM identity.staff_invitations WHERE organization_id = $1 AND role_definition_id = $2 AND status = 'pending' AND (expires_at IS NULL OR expires_at > now())`,
        [normalized.organizationId, roleId],
      );
      if (input.operation === "delete") {
        if (references.rowCount) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "role_in_use" as const };
        }
        await client.query(
          `UPDATE identity.organization_memberships SET role_definition_id = NULL WHERE organization_id = $1 AND role_definition_id = $2 AND status = 'inactive'`,
          [normalized.organizationId, roleId],
        );
        await client.query(
          `UPDATE identity.staff_invitations SET role_definition_id = NULL WHERE organization_id = $1 AND role_definition_id = $2 AND (status <> 'pending' OR expires_at <= now())`,
          [normalized.organizationId, roleId],
        );
        await client.query(
          `DELETE FROM identity.organization_roles WHERE organization_id = $1 AND id = $2`,
          [normalized.organizationId, roleId],
        );
      } else {
        if (
          references.rows.some(
            (row) =>
              row.role_key !== policy.baseRoleKey ||
              !resolveTeamRolePermissions(policy, row.permission_overrides),
          )
        ) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "invalid_member_overrides" as const };
        }
        await client.query(
          `UPDATE identity.organization_roles SET name = $3, description = $4, default_permissions = $5::jsonb WHERE organization_id = $1 AND id = $2`,
          [
            normalized.organizationId,
            roleId,
            normalized.name,
            normalized.description,
            JSON.stringify(policy.defaultPermissions),
          ],
        );
        for (const row of references.rows) {
          if (
            row.member_id &&
            resolveTeamRolePermissions(previousPolicy!, row.permission_overrides)?.includes(
              "pms.inbox.read",
            ) &&
            !resolveTeamRolePermissions(policy, row.permission_overrides)!.includes(
              "pms.inbox.read",
            )
          ) {
            await enqueueInboxAssignmentReconciliation(client, {
              organizationId: normalized.organizationId,
              membershipId: row.member_id,
              idempotencyId: reservationId,
              correlationId: command.audit.correlationId ?? command.audit.requestId,
              commandId: command.commandId,
              reason: "role_permissions_changed",
            });
          }
        }
      }
    }
    const outcome =
      input.operation === "create"
        ? "created"
        : input.operation === "update"
          ? "updated"
          : "deleted";
    await client.query(
      `INSERT INTO platform.product_audit_events
      (audit_key, product, action, occurred_at, tenant_scope, organization_id, actor_type, actor_user_id,
       target_resource_product, target_resource_type, target_resource_id, idempotency_key_id, correlation_id, causation_id,
       redacted_payload, private_payload, audit_metadata, retention_class, privacy_scope)
      VALUES ($1, 'identity', $12, $2, 'organization', $3, 'user', $4,
        'identity', 'organization_role', $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, 'security', 'confidential')`,
      [
        `team_role.${outcome}:${reservationId}`,
        command.audit.requestedAt,
        normalized.organizationId,
        normalized.actorUserId,
        roleId,
        reservationId,
        command.audit.correlationId ?? command.audit.requestId,
        command.commandId,
        JSON.stringify({ outcome, securityClass: policy.securityClass }),
        JSON.stringify({
          previous,
          next: input.operation === "delete" ? null : { ...normalized, ...policy },
        }),
        JSON.stringify({
          requestId: command.audit.requestId,
          source: command.audit.source,
          reason: command.audit.reason,
        }),
        `identity.team_role.${outcome}`,
      ],
    );
    await client.query(
      `UPDATE platform.idempotency_keys SET status = 'completed', response_status_code = $3, completed_at = now(),
      response_resource_product = 'identity', response_resource_type = 'organization_role', response_resource_id = $2
      WHERE id = $1`,
      [reservationId, roleId, input.operation === "create" ? 201 : 200],
    );
    await client.query("COMMIT");
    return { outcome, roleId: roleId! } as const;
  } catch (error) {
    await client.query("ROLLBACK");
    if (
      (error as { code?: string; constraint?: string }).code === "23505" &&
      (error as { constraint?: string }).constraint === "uq_organization_roles_name"
    )
      return { outcome: "rejected" as const, reason: "name_conflict" as const };
    throw error;
  } finally {
    client.release();
  }
}
