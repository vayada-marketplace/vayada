import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import type {
  createPayoutDestinationCodec,
  PayoutDestinationDetails,
} from "./financePayoutDestinationCodec.js";
import { recordBankTransferAudit } from "./financeBankTransferRepository.js";

type Codec = Pick<ReturnType<typeof createPayoutDestinationCodec>, "encrypt">;
export type PayoutDestinationSummary = {
  id: string;
  propertyId: string;
  revision: number;
  version: number;
  enabled: boolean;
  deleted: boolean;
  accountLast4: string;
  countryCode: string;
};
export type PayoutDestinationCommand = {
  propertyId: string;
  commandId: string;
  expectedVersion: number;
  actorId: string;
} & (
  | { action: "replace"; countryCode: string; details: PayoutDestinationDetails }
  | { action: "delete" }
);

const columns = `id::text, property_id::text AS "propertyId", revision, state_version AS version, enabled,
  deleted_at IS NOT NULL AS deleted, account_last4 AS "accountLast4", country_code AS "countryCode"`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** A hotel's vayada Payment payout account (VAY-2442). Owner writes only (the route checks);
 * the hotel reads it masked. Each write also keeps the hotel's vayada provider account in step:
 * `vayada:<property>` with payouts on exactly while an account is saved. That account is what
 * card readiness and Vayada's card approval bind to, so removing the payout account withdraws
 * the approval (the 0119 trigger bumps its capability revision), while replacing it does not. */
export function createPayoutDestinationRepository(
  connectionString: string,
  codec: Codec,
  afterCommit?: (pool: pg.Pool, propertyId: string) => Promise<unknown>,
) {
  const pool = new pg.Pool({ connectionString });
  async function read(propertyId: string, queryable: Pick<pg.Pool, "query"> = pool) {
    return (
      (
        await queryable.query<PayoutDestinationSummary>(
          `SELECT ${columns} FROM finance.payout_destinations
           WHERE property_id = $1::uuid ORDER BY revision DESC LIMIT 1`,
          [propertyId],
        )
      ).rows[0] ?? null
    );
  }
  return {
    read,
    async execute(command: PayoutDestinationCommand) {
      const client = await pool.connect();
      let result:
        | { status: "applied" | "replayed"; summary: PayoutDestinationSummary }
        | { status: "conflict" };
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'");
        const property = await client.query(
          "SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR UPDATE",
          [command.propertyId],
        );
        if (!property.rowCount) throw new Error();
        const keyHash = hash(`${command.propertyId}:${command.commandId}`);
        const fingerprint = hash(
          JSON.stringify({
            propertyId: command.propertyId,
            commandId: command.commandId,
            expectedVersion: command.expectedVersion,
            actorId: command.actorId,
            action: command.action,
            countryCode: command.action === "replace" ? command.countryCode : null,
            details:
              command.action === "replace"
                ? Object.entries(command.details).sort(([a], [b]) => a.localeCompare(b))
                : null,
          }),
        );
        const replay = (
          await client.query<{ fingerprint: string; summary: PayoutDestinationSummary }>(
            `SELECT request_fingerprint_hash AS fingerprint, idempotency_metadata->'summary' AS summary
             FROM platform.idempotency_keys WHERE operation_scope='finance'
             AND operation='payout_destination' AND key_hash=$1 AND property_id=$2::uuid`,
            [keyHash, command.propertyId],
          )
        ).rows[0];
        const previous = replay ? null : await read(command.propertyId, client);
        if (
          replay ||
          (previous?.version ?? 0) !== command.expectedVersion ||
          (command.action === "delete" && (!previous || previous.deleted))
        ) {
          await client.query("ROLLBACK");
          return replay?.fingerprint === fingerprint
            ? { status: "replayed" as const, summary: replay.summary }
            : { status: "conflict" as const };
        }
        let id = previous?.id ?? randomUUID();
        if (command.action === "replace") {
          id = randomUUID();
          const revision = (previous?.revision ?? 0) + 1;
          const encrypted = await codec.encrypt(
            { propertyId: command.propertyId, id, revision },
            command.details,
          );
          // Only the account in use keeps its details.
          await client.query(
            `UPDATE finance.payout_destinations SET enabled=FALSE, ciphertext=NULL, deleted_at=now()
             WHERE property_id=$1::uuid AND deleted_at IS NULL`,
            [command.propertyId],
          );
          await client.query(
            `INSERT INTO finance.payout_destinations
             (id, property_id, revision, state_version, ciphertext, key_arn, account_last4, country_code)
             VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8)`,
            [
              id,
              command.propertyId,
              revision,
              (previous?.version ?? 0) + 1,
              encrypted.ciphertext,
              encrypted.keyArn,
              encrypted.accountLast4,
              command.countryCode,
            ],
          );
        } else {
          await client.query(
            `UPDATE finance.payout_destinations SET enabled=FALSE, ciphertext=NULL, deleted_at=now(),
               state_version=state_version+1
             WHERE id=$1::uuid AND deleted_at IS NULL`,
            [id],
          );
        }
        await syncVayadaProviderAccount(client, command.propertyId, command.action === "replace");
        const summary = (await read(command.propertyId, client))!;
        await recordBankTransferAudit(client, {
          propertyId: command.propertyId,
          id,
          actorId: command.actorId,
          auditKey: keyHash,
          kind: "payout_destination",
          action: command.action === "delete" ? "deleted" : previous ? "replaced" : "created",
        });
        await client.query(
          `INSERT INTO platform.idempotency_keys
          (operation_scope, operation, key_hash, request_fingerprint_hash, status,
           tenant_scope, property_id, expires_at, completed_at, response_status_code, response_body_hash, idempotency_metadata)
          VALUES ('finance','payout_destination',$1,$2,'completed','property',$3::uuid,
                  'infinity'::timestamptz,now(),200,$4,$5::jsonb)`,
          [
            keyHash,
            fingerprint,
            command.propertyId,
            hash(JSON.stringify(summary)),
            JSON.stringify({ summary }),
          ],
        );
        await client.query("COMMIT");
        result = { status: "applied", summary };
      } catch {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error("Payout destination unavailable.");
      } finally {
        client.release();
      }
      // The provider account is part of the published prices' Finance fingerprint (VAY-2304).
      await afterCommit?.(pool, command.propertyId);
      return result;
    },
    close: () => pool.end(),
  };
}

/** Points the hotel's vayada provider account at `vayada:<property>` (a live binding, not the
 * settings placeholder) and sets payouts to whether a payout account is saved. Creates it when
 * the hotel never chose vayada Payment yet, in the shape the settings choice would. */
async function syncVayadaProviderAccount(
  client: pg.PoolClient,
  propertyId: string,
  payoutsEnabled: boolean,
) {
  const reference = `vayada:${propertyId}`;
  const existing = (
    await client.query<{ id: string }>(
      `SELECT id::text FROM finance.payment_provider_accounts
       WHERE property_id=$1::uuid AND account_scope='property' AND provider='vayada'
       ORDER BY (provider_account_id LIKE 'settings-choice:%'), updated_at DESC
       LIMIT 1 FOR UPDATE`,
      [propertyId],
    )
  ).rows[0];
  if (existing) {
    await client.query(
      `UPDATE finance.payment_provider_accounts
       SET provider_account_id=$2, payouts_enabled=$3, updated_at=now()
       WHERE id=$1::uuid
         AND (provider_account_id IS DISTINCT FROM $2 OR payouts_enabled IS DISTINCT FROM $3)`,
      [existing.id, reference, payoutsEnabled],
    );
    return;
  }
  await client.query(
    `INSERT INTO finance.payment_provider_accounts (
       property_id, account_scope, provider, provider_account_id, status, onboarding_status,
       charges_enabled, payouts_enabled, default_currency, capabilities, card_capability_revision,
       account_metadata)
     SELECT $1::uuid, 'property', 'vayada', $2, 'active', 'completed', TRUE, $3,
       COALESCE(
         (SELECT default_currency FROM finance.payment_settings WHERE property_id=$1::uuid),
         (SELECT currency FROM pms.property_pricing_settings WHERE property_id=$1::uuid)),
       ARRAY['card_payments']::text[], 1, '{"source":"payout_destination"}'::jsonb`,
    [propertyId, reference, payoutsEnabled],
  );
}
