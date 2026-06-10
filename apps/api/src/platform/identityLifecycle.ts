import { randomUUID } from "node:crypto";
import type {
  CreateIdentityUserCommand,
  IdentityLifecycleCommand,
  IdentityLifecycleCommandBus,
  IdentityLifecycleCommandResult,
  IdentityLifecycleEvent,
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
      if (command.commandType !== "identity.user.create") {
        throw new Error(`Unsupported identity lifecycle command: ${command.commandType}`);
      }
      return createIdentityUser(pool, command);
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
    const existing = await client.query<{ user_id: string }>(
      `SELECT user_id
       FROM identity.external_identities
       WHERE provider = $1 AND provider_user_id = $2
       LIMIT 1`,
      [
        command.payload.providerIdentity?.provider ?? "workos",
        command.payload.providerIdentity?.providerUserId ?? null,
      ],
    );
    const existingUserId = existing.rows[0]?.user_id;
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
