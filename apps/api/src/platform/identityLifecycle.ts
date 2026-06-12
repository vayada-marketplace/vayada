import { randomUUID } from "node:crypto";
import type {
  CreateIdentityUserCommand,
  DeleteIdentityUserCommand,
  GrantIdentityAccessCommand,
  IdentityLifecycleCommand,
  IdentityLifecycleCommandBus,
  IdentityLifecycleCommandResult,
  IdentityLifecycleEvent,
  RevokeIdentityAccessCommand,
  SuspendIdentityUserCommand,
  UpdateIdentityUserEmailCommand,
  UpdateIdentityUserProfileCommand,
  UpdateIdentityUserStatusCommand,
} from "@vayada/backend-auth";
import pg from "pg";

type PgIdentityLifecycleCommandBusConfig = {
  connectionString: string;
  max?: number;
};

export function createPgIdentityLifecycleCommandBus(
  config: PgIdentityLifecycleCommandBusConfig,
): IdentityLifecycleCommandBus {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async execute(command) {
      switch (command.commandType) {
        case "identity.user.create":
          return createIdentityUser(pool, command);
        case "identity.user.profile.update":
          return updateIdentityUserProfile(pool, command);
        case "identity.user.email.update":
          return updateIdentityUserEmail(pool, command);
        case "identity.user.status.update":
          return updateIdentityUserStatus(pool, command);
        case "identity.user.suspend":
          return suspendIdentityUser(pool, command);
        case "identity.user.delete":
          return deleteIdentityUser(pool, command);
        case "identity.access.grant":
          return grantIdentityAccess(pool, command);
        case "identity.access.revoke":
          return revokeIdentityAccess(pool, command);
        default:
          throw new Error(`Unsupported identity lifecycle command: ${command.commandType}`);
      }
    },
  };
}

async function createIdentityUser(
  pool: pg.Pool,
  command: CreateIdentityUserCommand,
): Promise<IdentityLifecycleCommandResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existingProviderUserId = command.payload.providerIdentity?.providerUserId;
    if (existingProviderUserId) {
      const existingIdentity = await client.query<{ user_id: string }>(
        `SELECT user_id
         FROM identity.external_identities
         WHERE provider = $1 AND provider_user_id = $2
         LIMIT 1`,
        [command.payload.providerIdentity?.provider ?? "workos", existingProviderUserId],
      );
      const existingUserId = existingIdentity.rows[0]?.user_id;
      if (existingUserId) {
        await client.query("COMMIT");
        return {
          status: "idempotent_replay",
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          userId: existingUserId,
          events: [],
        };
      }
    }

    const existingEmail = await client.query<{ id: string }>(
      `SELECT id
       FROM identity.users
       WHERE lower(email) = lower($1)
         AND status <> 'deleted'
       ORDER BY created_at ASC
       LIMIT 1`,
      [command.payload.email],
    );
    const existingEmailUserId = existingEmail.rows[0]?.id;
    if (existingEmailUserId) {
      await client.query("COMMIT");
      return {
        status: "idempotent_replay",
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        userId: existingEmailUserId,
        events: [],
      };
    }

    const user = await client.query<{ id: string }>(
      `INSERT INTO identity.users (email, name, status)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [command.payload.email, command.payload.name ?? null, command.payload.initialStatus],
    );
    const userId = user.rows[0]?.id;
    if (!userId) {
      throw new Error("identity.user.create did not return a user id");
    }

    await client.query(
      `INSERT INTO identity.external_identities
         (user_id, provider, provider_user_id, provider_email, provider_email_verified, last_login_at, raw_profile)
       VALUES ($1, $2, $3, $4, $5, now(), $6)`,
      [
        userId,
        command.payload.providerIdentity?.provider ?? "workos",
        command.payload.providerIdentity?.providerUserId ?? null,
        command.payload.email,
        command.payload.providerIdentity?.providerEmailVerified ?? false,
        JSON.stringify({
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          source: "authkit_jit",
        }),
      ],
    );

    const event: IdentityLifecycleEvent = {
      eventType: "identity.user.created",
      eventId: randomUUID(),
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      userId,
      occurredAt: new Date().toISOString(),
      audit: command.audit,
      payload: command.payload,
    };
    await client.query(
      `INSERT INTO identity.auth_reconciliation_events
         (event_type, provider, provider_event_id, user_id, payload, processed_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [
        event.eventType,
        command.payload.providerIdentity?.provider ?? "workos",
        command.payload.providerIdentity?.providerUserId ?? null,
        userId,
        JSON.stringify(event),
      ],
    );

    await client.query("COMMIT");
    return {
      status: "accepted",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      userId,
      events: [event],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function updateIdentityUserProfile(
  pool: pg.Pool,
  command: UpdateIdentityUserProfileCommand,
): Promise<IdentityLifecycleCommandResult> {
  await pool.query(
    `UPDATE identity.users
     SET name = COALESCE($2, name), updated_at = now()
     WHERE id = $1`,
    [command.payload.userId, command.payload.name ?? null],
  );
  return accepted(command, command.payload.userId, "identity.user.profile.updated");
}

async function updateIdentityUserEmail(
  pool: pg.Pool,
  command: UpdateIdentityUserEmailCommand,
): Promise<IdentityLifecycleCommandResult> {
  await pool.query(
    `UPDATE identity.users
     SET email = $2, updated_at = now()
     WHERE id = $1`,
    [command.payload.userId, command.payload.email],
  );
  await pool.query(
    `UPDATE identity.external_identities
     SET provider_email = $2,
         provider_email_verified = COALESCE($3, provider_email_verified),
         updated_at = now()
     WHERE user_id = $1`,
    [
      command.payload.userId,
      command.payload.email,
      command.payload.providerEmailVerified ?? null,
    ],
  );
  return accepted(command, command.payload.userId, "identity.user.email.updated");
}

async function updateIdentityUserStatus(
  pool: pg.Pool,
  command: UpdateIdentityUserStatusCommand,
): Promise<IdentityLifecycleCommandResult> {
  await pool.query(
    `UPDATE identity.users
     SET status = $2, updated_at = now()
     WHERE id = $1`,
    [command.payload.userId, command.payload.status],
  );
  return accepted(command, command.payload.userId, "identity.user.status.updated");
}

async function suspendIdentityUser(
  pool: pg.Pool,
  command: SuspendIdentityUserCommand,
): Promise<IdentityLifecycleCommandResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE identity.users
       SET status = 'suspended', updated_at = now()
       WHERE id = $1`,
      [command.payload.userId],
    );
    if (command.payload.suspendMemberships) {
      await client.query(
        `UPDATE identity.organization_memberships
         SET status = 'suspended', updated_at = now()
         WHERE user_id = $1`,
        [command.payload.userId],
      );
    }
    if (command.payload.suspendResourceLinks) {
      await client.query(
        `UPDATE identity.organization_resource_links AS links
         SET status = 'suspended', updated_at = now()
         FROM identity.organization_memberships AS memberships
         WHERE memberships.organization_id = links.organization_id
           AND memberships.user_id = $1`,
        [command.payload.userId],
      );
    }
    await client.query("COMMIT");
    return accepted(command, command.payload.userId, "identity.user.suspended");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function deleteIdentityUser(
  pool: pg.Pool,
  command: DeleteIdentityUserCommand,
): Promise<IdentityLifecycleCommandResult> {
  const email =
    command.payload.mode === "privacy_erasure"
      ? `deleted+${command.payload.userId}@deleted.vayada.local`
      : undefined;
  await pool.query(
    `UPDATE identity.users
     SET status = 'deleted',
         email = COALESCE($2, email),
         name = CASE WHEN $2 IS NULL THEN name ELSE NULL END,
         updated_at = now()
     WHERE id = $1`,
    [command.payload.userId, email ?? null],
  );
  return accepted(command, command.payload.userId, "identity.user.deleted");
}

async function grantIdentityAccess(
  pool: pg.Pool,
  command: GrantIdentityAccessCommand,
): Promise<IdentityLifecycleCommandResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const organizationId = await upsertOrganization(client, command.payload.organization);
    await client.query(
      `INSERT INTO identity.organization_memberships
         (organization_id, user_id, status, role_key, workos_membership_id, workos_role_slugs, invited_at)
       VALUES ($1, $2, COALESCE($3, 'active'), $4, $5, COALESCE($6, '{}'), $7)
       ON CONFLICT (organization_id, user_id)
       DO UPDATE SET
         status = EXCLUDED.status,
         role_key = EXCLUDED.role_key,
         workos_membership_id = COALESCE(EXCLUDED.workos_membership_id, identity.organization_memberships.workos_membership_id),
         workos_role_slugs = EXCLUDED.workos_role_slugs,
         updated_at = now()`,
      [
        organizationId,
        command.payload.userId,
        command.payload.membership.status ?? "active",
        command.payload.membership.roleKey,
        command.payload.membership.workosMembershipId ?? null,
        command.payload.membership.workosRoleSlugs ?? [],
        command.payload.membership.invitedAt ?? null,
      ],
    );
    for (const link of command.payload.resourceLinks ?? []) {
      await client.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'active'))
         ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
         DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
        [
          link.organizationId ?? organizationId,
          link.product,
          link.resourceType,
          link.resourceId,
          link.relationship,
          link.status ?? "active",
        ],
      );
    }
    for (const grant of command.payload.permissionGrants ?? []) {
      await client.query(
        `INSERT INTO identity.role_permission_grants
           (organization_kind, role_key, permission_key)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_kind, role_key, permission_key) DO NOTHING`,
        [grant.organizationKind, grant.roleKey, grant.permissionKey],
      );
    }
    await client.query("COMMIT");
    return accepted(command, command.payload.userId, "identity.access.granted", organizationId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function revokeIdentityAccess(
  pool: pg.Pool,
  command: RevokeIdentityAccessCommand,
): Promise<IdentityLifecycleCommandResult> {
  const membershipStatus = command.payload.membershipStatus ?? "inactive";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE identity.organization_memberships
       SET status = $3, updated_at = now()
       WHERE organization_id = $1 AND user_id = $2`,
      [command.payload.organizationId, command.payload.userId, membershipStatus],
    );
    for (const link of command.payload.resourceLinks ?? []) {
      await client.query(
        `UPDATE identity.organization_resource_links
         SET status = 'suspended', updated_at = now()
         WHERE organization_id = $1
           AND product = $2
           AND resource_type = $3
           AND resource_id = $4
           AND relationship = $5`,
        [
          command.payload.organizationId,
          link.product,
          link.resourceType,
          link.resourceId,
          link.relationship,
        ],
      );
    }
    await client.query("COMMIT");
    return accepted(
      command,
      command.payload.userId,
      "identity.access.revoked",
      command.payload.organizationId,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function upsertOrganization(
  client: pg.PoolClient,
  organization: GrantIdentityAccessCommand["payload"]["organization"],
): Promise<string> {
  const slug = organization.slug ?? slugify(organization.name);
  if (organization.organizationId) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO identity.organizations
         (id, kind, name, slug, status, workos_org_id, workos_external_id)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'active'), $6, $7)
       ON CONFLICT (id)
       DO UPDATE SET
         kind = EXCLUDED.kind,
         name = EXCLUDED.name,
         slug = EXCLUDED.slug,
         status = EXCLUDED.status,
         workos_org_id = COALESCE(EXCLUDED.workos_org_id, identity.organizations.workos_org_id),
         workos_external_id = COALESCE(EXCLUDED.workos_external_id, identity.organizations.workos_external_id),
         updated_at = now()
       RETURNING id`,
      [
        organization.organizationId,
        organization.kind,
        organization.name,
        slug,
        organization.status ?? "active",
        organization.workosOrgId ?? null,
        organization.workosExternalId ?? null,
      ],
    );
    return result.rows[0]!.id;
  }

  const result = await client.query<{ id: string }>(
    `INSERT INTO identity.organizations
       (kind, name, slug, status, workos_org_id, workos_external_id)
     VALUES ($1, $2, $3, COALESCE($4, 'active'), $5, $6)
     RETURNING id`,
    [
      organization.kind,
      organization.name,
      slug,
      organization.status ?? "active",
      organization.workosOrgId ?? null,
      organization.workosExternalId ?? null,
    ],
  );
  return result.rows[0]!.id;
}

function accepted(
  command: IdentityLifecycleCommand,
  userId: string | undefined,
  eventType: IdentityLifecycleEvent["eventType"],
  organizationId?: string,
): IdentityLifecycleCommandResult {
  const event: IdentityLifecycleEvent = {
    eventType,
    eventId: randomUUID(),
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    userId,
    organizationId,
    occurredAt: new Date().toISOString(),
    audit: command.audit,
    payload: command.payload,
  } as IdentityLifecycleEvent;

  return {
    status: "accepted",
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    userId,
    organizationId,
    events: [event],
  };
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "organization";
}
