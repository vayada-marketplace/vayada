import { randomUUID } from "node:crypto";
import pg from "pg";
import type { createPayoutDestinationCodec } from "./financePayoutDestinationCodec.js";
import { recordBankTransferAudit } from "./financeBankTransferRepository.js";

type Codec = Pick<ReturnType<typeof createPayoutDestinationCodec>, "decrypt">;
type Queryable = Pick<pg.PoolClient, "query">;

/** Money in the ledger's minor units, as strings (BIGINT never passes through a JS number). */
export type VayadaPayoutHotel = {
  propertyId: string;
  name: string;
  currency: string;
  /** Everything owed for stays that checked out by the cut-off, less payouts (can be negative). */
  payableMinor: string;
  /** What to send now: the payable amount, in whole rupiah for IDR; 0 when nothing is owed. */
  payNowMinor: string;
  /** Owed for stays that check out after the cut-off, or whose refund is still on its way. */
  upcomingMinor: string;
  destination: { id: string; accountLast4: string; countryCode: string } | null;
  /** A payout started but not yet marked sent: finish it (or cancel it) before anything else. */
  sending: { id: string; amountMinor: string; startedAt: string } | null;
  lastPayout: { id: string; amountMinor: string; paidOn: string; reference: string } | null;
};
export type VayadaPayoutEntry = {
  id: string;
  kind: string;
  currency: string;
  grossMinor: string;
  feeMinor: string;
  netMinor: string;
  bookingReference: string | null;
  checkOut: string | null;
  occurredAt: string;
};
export type VayadaPayout = {
  id: string;
  currency: string;
  amountMinor: string;
  cutoff: string;
  accountLast4: string;
  startedAt: string;
  reference: string | null;
  paidOn: string | null;
  sentAt: string | null;
  returnedAt: string | null;
  returnReason: string | null;
};
export type StartVayadaPayoutCommand = {
  propertyId: string;
  commandId: string;
  livemode: boolean;
  currency: string;
  cutoff: string;
  amountMinor: string;
  /** The payout account the operator was shown: the payout is refused if it changed since. */
  destinationId: string;
  actorId: string;
};
export type SentVayadaPayoutCommand = {
  propertyId: string;
  payoutId: string;
  reference: string;
  paidOn: string;
  actorId: string;
};
export type ReturnVayadaPayoutCommand = {
  propertyId: string;
  payoutId: string;
  commandId: string;
  reason: string;
  actorId: string;
};

/** The Sunday before `today` (UTC): payouts go out on Mondays for stays checked out by then. */
export function vayadaPayoutCutoff(today: Date): string {
  const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() === 0 ? 7 : day.getUTCDay()));
  return day.toISOString().slice(0, 10);
}

/** Banks pay rupiah in whole rupiah; Stripe counts IDR in hundredths. The rest stays owed. */
export function vayadaPayNow(currency: string, payableMinor: bigint): bigint {
  if (payableMinor <= 0n) return 0n;
  return currency === "IDR" ? payableMinor - (payableMinor % 100n) : payableMinor;
}

// A stay's current check-out decides its payout week (a moved stay moves with it); payouts and
// other rows without a booking always count. A payment with a refund still on its way to Stripe
// waits: paying it now would leave the hotel owing once the refund lands.
const BALANCE = `
  SELECT l.property_id::text AS "propertyId", p.display_name AS name, trim(l.currency) AS currency,
    COALESCE(sum(l.net_minor) FILTER (
      WHERE pending.payment_id IS NULL
        AND (COALESCE(b.check_out, l.stay_check_out) IS NULL
          OR COALESCE(b.check_out, l.stay_check_out) <= $2::date)), 0)::text AS payable,
    COALESCE(sum(l.net_minor) FILTER (
      WHERE pending.payment_id IS NOT NULL
         OR COALESCE(b.check_out, l.stay_check_out) > $2::date), 0)::text AS upcoming
  FROM finance.hotel_payout_ledger l
  JOIN hotel_catalog.properties p ON p.id = l.property_id
  LEFT JOIN booking.guest_bookings b ON b.id = l.guest_booking_id AND b.property_id = l.property_id
  LEFT JOIN (
    SELECT DISTINCT payment_id FROM finance.card_refund_commands WHERE status = 'pending'
  ) pending ON pending.payment_id = l.payment_id
  WHERE l.livemode = $1`;

const PAYOUT_COLUMNS = `h.id::text, trim(h.currency) AS currency, h.amount_minor::text AS "amountMinor",
  h.cutoff::text, d.account_last4 AS "accountLast4",
  to_char(h.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "startedAt",
  h.reference, h.paid_on::text AS "paidOn",
  to_char(h.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "sentAt",
  to_char(h.returned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "returnedAt",
  h.return_reason AS "returnReason"`;

/** vayada Payment payouts for Vayada staff (VAY-2442 P5): what each hotel is owed, its lines and
 * payouts, starting a payout before the money is sent by hand, marking it sent, a payout cancelled
 * or sent back by the bank, and the hotel's bank details to send it to. Live and test-mode money
 * are separate ledgers that never mix. */
export function createVayadaPaymentPayoutRepository(connectionString: string, codec?: Codec) {
  const pool = new pg.Pool({ connectionString, max: 5 });

  async function destination(queryable: Queryable, propertyId: string) {
    return (
      (
        await queryable.query<{
          id: string;
          revision: number;
          ciphertext: Buffer;
          keyArn: string;
          accountLast4: string;
          countryCode: string;
        }>(
          `SELECT id::text, revision, ciphertext, key_arn AS "keyArn", account_last4 AS "accountLast4",
             country_code AS "countryCode"
           FROM finance.payout_destinations WHERE property_id=$1::uuid AND enabled`,
          [propertyId],
        )
      ).rows[0] ?? null
    );
  }

  async function hotels(
    queryable: Queryable,
    input: { livemode: boolean; cutoff: string; propertyId?: string },
  ): Promise<VayadaPayoutHotel[]> {
    const rows = (
      await queryable.query<{
        propertyId: string;
        name: string;
        currency: string;
        payable: string;
        upcoming: string;
        destinationId: string | null;
        accountLast4: string | null;
        countryCode: string | null;
        sendingId: string | null;
        sendingAmount: string | null;
        sendingStartedAt: string | null;
        payoutId: string | null;
        payoutAmount: string | null;
        paidOn: string | null;
        reference: string | null;
      }>(
        `WITH balance AS (${BALANCE}
           ${input.propertyId ? "AND l.property_id = $3::uuid" : ""}
           GROUP BY 1, 2, 3)
         SELECT balance.*, d.id::text AS "destinationId", d.account_last4 AS "accountLast4",
           d.country_code AS "countryCode",
           sending.id::text AS "sendingId", sending.amount_minor::text AS "sendingAmount",
           to_char(sending.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
             AS "sendingStartedAt",
           last.id::text AS "payoutId", last.amount_minor::text AS "payoutAmount",
           last.paid_on::text AS "paidOn", last.reference
         FROM balance
         LEFT JOIN finance.payout_destinations d
           ON d.property_id = balance."propertyId"::uuid AND d.enabled
         LEFT JOIN LATERAL (
           SELECT id, amount_minor, started_at FROM finance.hotel_payouts h
           WHERE h.property_id = balance."propertyId"::uuid AND h.currency = balance.currency
             AND h.livemode = $1 AND h.sent_at IS NULL AND h.returned_at IS NULL
           ORDER BY h.started_at DESC LIMIT 1
         ) sending ON true
         LEFT JOIN LATERAL (
           SELECT id, amount_minor, paid_on, reference FROM finance.hotel_payouts h
           WHERE h.property_id = balance."propertyId"::uuid AND h.currency = balance.currency
             AND h.livemode = $1 AND h.sent_at IS NOT NULL AND h.returned_at IS NULL
           ORDER BY h.sent_at DESC LIMIT 1
         ) last ON true
         ORDER BY balance.name, balance."propertyId", balance.currency`,
        input.propertyId
          ? [input.livemode, input.cutoff, input.propertyId]
          : [input.livemode, input.cutoff],
      )
    ).rows;
    return rows.map((row) => ({
      propertyId: row.propertyId,
      name: row.name,
      currency: row.currency,
      payableMinor: row.payable,
      payNowMinor: vayadaPayNow(row.currency, BigInt(row.payable)).toString(),
      upcomingMinor: row.upcoming,
      destination:
        row.destinationId && row.accountLast4 && row.countryCode
          ? { id: row.destinationId, accountLast4: row.accountLast4, countryCode: row.countryCode }
          : null,
      sending:
        row.sendingId && row.sendingAmount && row.sendingStartedAt
          ? { id: row.sendingId, amountMinor: row.sendingAmount, startedAt: row.sendingStartedAt }
          : null,
      lastPayout:
        row.payoutId && row.payoutAmount && row.paidOn && row.reference
          ? {
              id: row.payoutId,
              amountMinor: row.payoutAmount,
              paidOn: row.paidOn,
              reference: row.reference,
            }
          : null,
    }));
  }

  /** One payout command at a time per hotel; a wait longer than 5 s answers "busy". */
  async function locked<T>(propertyId: string, work: (client: pg.PoolClient) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `vayada-payout:${propertyId}`,
      ]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const code = (error as { code?: string }).code;
      if (code === "55P03") return { status: "busy" as const };
      // Two first sends of one command at once: the other one recorded it.
      if (code === "23505") return { status: "conflict" as const };
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    list: (input: { livemode: boolean; cutoff: string }) => hotels(pool, input),

    async detail(input: { propertyId: string; livemode: boolean; cutoff: string }) {
      const name = (
        await pool.query<{ name: string }>(
          "SELECT display_name AS name FROM hotel_catalog.properties WHERE id=$1::uuid",
          [input.propertyId],
        )
      ).rows[0]?.name;
      if (name === undefined) return null;
      const [balances, entries, payouts, account] = await Promise.all([
        hotels(pool, input),
        pool.query<VayadaPayoutEntry>(
          `SELECT l.id::text, l.entry_kind AS kind, trim(l.currency) AS currency,
             l.gross_minor::text AS "grossMinor", l.fee_minor::text AS "feeMinor",
             l.net_minor::text AS "netMinor", b.public_reference AS "bookingReference",
             COALESCE(b.check_out, l.stay_check_out)::text AS "checkOut",
             to_char(l.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "occurredAt"
           FROM finance.hotel_payout_ledger l
           LEFT JOIN booking.guest_bookings b
             ON b.id = l.guest_booking_id AND b.property_id = l.property_id
           WHERE l.property_id=$1::uuid AND l.livemode=$2
           ORDER BY l.occurred_at DESC, l.id LIMIT 500`,
          [input.propertyId, input.livemode],
        ),
        pool.query<VayadaPayout>(
          `SELECT ${PAYOUT_COLUMNS}
           FROM finance.hotel_payouts h
           JOIN finance.payout_destinations d
             ON d.id = h.payout_destination_id AND d.property_id = h.property_id
           WHERE h.property_id=$1::uuid AND h.livemode=$2
           ORDER BY h.started_at DESC`,
          [input.propertyId, input.livemode],
        ),
        destination(pool, input.propertyId),
      ]);
      return {
        propertyId: input.propertyId,
        name,
        balances,
        destination: account
          ? { id: account.id, accountLast4: account.accountLast4, countryCode: account.countryCode }
          : null,
        entries: entries.rows,
        payouts: payouts.rows,
      };
    },

    /** Starts a payout before any money moves: exactly what is owed now at the cut-off, to the
     * payout account the operator was shown. From here the hotel's balance no longer includes it,
     * so nobody can send it twice; a changed balance or account is refused with the new state. */
    start(command: StartVayadaPayoutCommand) {
      return locked(command.propertyId, async (client) => {
        const replay = (
          await client.query<{ id: string; same: boolean }>(
            `SELECT id::text, (property_id=$2::uuid AND amount_minor=$3::bigint AND currency=$4
               AND livemode=$5 AND cutoff=$6::date AND payout_destination_id=$7::uuid) AS same
             FROM finance.hotel_payouts WHERE command_id=$1::uuid`,
            [
              command.commandId,
              command.propertyId,
              command.amountMinor,
              command.currency,
              command.livemode,
              command.cutoff,
              command.destinationId,
            ],
          )
        ).rows[0];
        if (replay)
          return replay.same
            ? { status: "replayed" as const, payoutId: replay.id }
            : { status: "conflict" as const };
        const account = await destination(client, command.propertyId);
        if (!account) return { status: "no_destination" as const };
        if (account.id !== command.destinationId) return { status: "destination_changed" as const };
        const owed = (
          await hotels(client, {
            livemode: command.livemode,
            cutoff: command.cutoff,
            propertyId: command.propertyId,
          })
        ).find((hotel) => hotel.currency === command.currency);
        const payNow = owed?.payNowMinor ?? "0";
        if (payNow !== command.amountMinor || payNow === "0")
          return { status: "amount_changed" as const, payNowMinor: payNow };
        const id = randomUUID();
        await client.query(
          `INSERT INTO finance.hotel_payouts (id, property_id, command_id, currency, amount_minor,
             livemode, cutoff, payout_destination_id, started_by_user_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::bigint, $6, $7::date, $8::uuid, $9::uuid)`,
          [
            id,
            command.propertyId,
            command.commandId,
            command.currency,
            command.amountMinor,
            command.livemode,
            command.cutoff,
            account.id,
            command.actorId,
          ],
        );
        await ledger(client, {
          propertyId: command.propertyId,
          kind: "payout",
          currency: command.currency,
          net: -BigInt(command.amountMinor),
          livemode: command.livemode,
          sourceKey: `payout:${id}`,
        });
        await audit(client, command.propertyId, id, "started", command.actorId);
        return { status: "started" as const, payoutId: id };
      });
    },

    /** The money went out: the transfer's reference and the day it was paid. Once; never after a
     * payout was cancelled. */
    markSent(command: SentVayadaPayoutCommand) {
      return locked(command.propertyId, async (client) => {
        const payout = (
          await client.query<{
            reference: string | null;
            paidOn: string | null;
            returned: boolean;
            early: boolean;
          }>(
            `SELECT reference, paid_on::text AS "paidOn", returned_at IS NOT NULL AS returned,
               $3::date < (started_at AT TIME ZONE 'UTC')::date - 1 AS early
             FROM finance.hotel_payouts WHERE id=$1::uuid AND property_id=$2::uuid FOR UPDATE`,
            [command.payoutId, command.propertyId, command.paidOn],
          )
        ).rows[0];
        if (!payout) return { status: "not_found" as const };
        if (payout.reference !== null)
          return payout.reference === command.reference && payout.paidOn === command.paidOn
            ? { status: "replayed" as const }
            : { status: "conflict" as const };
        if (payout.returned) return { status: "conflict" as const };
        if (payout.early) return { status: "invalid_date" as const };
        await client.query(
          `UPDATE finance.hotel_payouts SET reference=$2, paid_on=$3::date, sent_by_user_id=$4::uuid,
             sent_at=now()
           WHERE id=$1::uuid`,
          [command.payoutId, command.reference, command.paidOn, command.actorId],
        );
        await audit(client, command.propertyId, command.payoutId, "sent", command.actorId);
        return { status: "sent" as const };
      });
    },

    /** A payout cancelled before sending, or sent back by the bank: the hotel is owed it again
     * (a payout_returned row). Once. */
    markReturned(command: ReturnVayadaPayoutCommand) {
      return locked(command.propertyId, async (client) => {
        const payout = (
          await client.query<{
            currency: string;
            amount: string;
            livemode: boolean;
            returnCommandId: string | null;
          }>(
            `SELECT trim(currency) AS currency, amount_minor::text AS amount, livemode,
               return_command_id::text AS "returnCommandId"
             FROM finance.hotel_payouts WHERE id=$1::uuid AND property_id=$2::uuid FOR UPDATE`,
            [command.payoutId, command.propertyId],
          )
        ).rows[0];
        if (!payout) return { status: "not_found" as const };
        if (payout.returnCommandId)
          return payout.returnCommandId === command.commandId
            ? { status: "replayed" as const }
            : { status: "conflict" as const };
        await client.query(
          `UPDATE finance.hotel_payouts SET return_command_id=$2::uuid, returned_at=now(),
             returned_by_user_id=$3::uuid, return_reason=$4
           WHERE id=$1::uuid`,
          [command.payoutId, command.commandId, command.actorId, command.reason],
        );
        await ledger(client, {
          propertyId: command.propertyId,
          kind: "payout_returned",
          currency: payout.currency,
          net: BigInt(payout.amount),
          livemode: payout.livemode,
          sourceKey: `payout_returned:${command.payoutId}`,
        });
        await audit(client, command.propertyId, command.payoutId, "returned", command.actorId);
        return { status: "returned" as const };
      });
    },

    /** The hotel's bank details to send a payout to: only the account the operator expects (the
     * one a payout was started for), and every look is audited. */
    async revealDestination(propertyId: string, actorId: string, destinationId?: string) {
      if (!codec) return { status: "unavailable" as const };
      const account = await destination(pool, propertyId);
      if (!account) return { status: "not_found" as const };
      if (destinationId && account.id !== destinationId)
        return { status: "destination_changed" as const };
      let details: Awaited<ReturnType<Codec["decrypt"]>>;
      try {
        details = await codec.decrypt(
          { propertyId, id: account.id, revision: account.revision },
          { ciphertext: account.ciphertext, keyArn: account.keyArn },
        );
      } catch {
        return { status: "unavailable" as const };
      }
      await recordBankTransferAudit(pool, {
        propertyId,
        id: account.id,
        action: "revealed",
        actorId,
        auditKey: randomUUID(),
        kind: "payout_destination",
      });
      return {
        status: "revealed" as const,
        destinationId: account.id,
        countryCode: account.countryCode,
        details,
      };
    },

    close: () => pool.end(),
  };
}

async function ledger(
  client: Queryable,
  entry: {
    propertyId: string;
    kind: "payout" | "payout_returned";
    currency: string;
    net: bigint;
    livemode: boolean;
    sourceKey: string;
  },
) {
  await client.query(
    `INSERT INTO finance.hotel_payout_ledger (property_id, entry_kind, currency, gross_minor,
       fee_minor, net_minor, livemode, source_key, occurred_at)
     VALUES ($1::uuid, $2, $3, $4, 0, $4, $5, $6, clock_timestamp())`,
    [
      entry.propertyId,
      entry.kind,
      entry.currency,
      entry.net.toString(),
      entry.livemode,
      entry.sourceKey,
    ],
  );
}

async function audit(
  client: Queryable,
  propertyId: string,
  payoutId: string,
  action: "started" | "sent" | "returned",
  actorId: string,
) {
  await client.query(
    `INSERT INTO platform.product_audit_events
      (audit_key, product, action, action_version, occurred_at, tenant_scope, property_id,
       actor_type, actor_user_id, target_resource_product, target_resource_type, target_resource_id,
       redacted_payload, private_payload, audit_metadata, retention_class, privacy_scope)
     VALUES ($1, 'finance', $2, 1, now(), 'property', $3::uuid, 'user', $4::uuid, 'finance',
       'vayada_payout', $5, $6::jsonb, '{}'::jsonb, '{}'::jsonb, 'financial', 'confidential')
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `vayada-payout:${payoutId}:${action}`,
      `finance.vayada_payout.${action}`,
      propertyId,
      actorId,
      payoutId,
      JSON.stringify({ payoutId }),
    ],
  );
}
