import { randomUUID } from "node:crypto";
import pg from "pg";
import type { createPayoutDestinationCodec } from "./financePayoutDestinationCodec.js";
import { recordBankTransferAudit } from "./financeBankTransferRepository.js";
import { stripeAmountMinor } from "./stripeMoney.js";

type Codec = Pick<ReturnType<typeof createPayoutDestinationCodec>, "decrypt">;
type Queryable = Pick<pg.PoolClient, "query">;

/** The hotel's payout account in use (P7): staff approve each account before money goes to it. */
export type VayadaPayoutAccount = {
  id: string;
  accountLast4: string;
  countryCode: string;
  /** When the owner saved this account. */
  savedAt: string;
  /** The hotel had an account before this one. */
  replaced: boolean;
  /** Vayada staff approved it with "Approve bank account" (an account approved before 2026-11-03
   * may carry the hotel's first card approval instead). */
  approved: boolean;
  approvedAt: string | null;
  /** How: staff's "Approve bank account", or (before 2026-11-03 only) the first card approval. */
  approvedVia: "payout_account" | "card_approval" | null;
};
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
  destination: VayadaPayoutAccount | null;
  /** A payout started but not yet marked sent: finish it (or cancel it) before anything else.
   * `destinationId` is the account it was started for: an older one if the hotel replaced it. */
  sending: { id: string; amountMinor: string; startedAt: string; destinationId: string } | null;
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
  /** The payout account it was started for (an older one if the hotel replaced it since). */
  destinationId: string;
  accountLast4: string;
  startedAt: string;
  reference: string | null;
  paidOn: string | null;
  sentAt: string | null;
  returnedAt: string | null;
  returnReason: string | null;
};
/** The hotel's own payout statement (VAY-2584): live money only, the same ledger and payouts Vayada
 * staff see, without staff-only details (transfer references, return reasons, account approval). */
export type VayadaPayoutStatement = {
  /** One per currency the hotel was paid in (almost always one). */
  totals: {
    currency: string;
    /** The next Monday payout: for stays checking out by `cutoff`, less what was paid out. */
    nextPayout: {
      on: string;
      cutoff: string;
      /** What goes out (whole rupiah for IDR; 0 when nothing is owed). */
      amountMinor: string;
      /** What is owed by the cut-off: below zero when refunds or disputes took more. */
      balanceMinor: string;
    };
    /** Owed for stays checking out after the cut-off, or whose refund is still on its way. */
    upcomingMinor: string;
    /** Payouts sent and not returned by the bank. */
    paidOutMinor: string;
    firstPaidOn: string | null;
  }[];
  /** The account payouts go to now, masked to its last four characters. */
  account: { accountLast4: string; countryCode: string } | null;
  payouts: {
    id: string;
    currency: string;
    amountMinor: string;
    accountLast4: string;
    startedOn: string;
    paidOn: string | null;
    returnedOn: string | null;
    /** Started but not sent yet; sent; sent and returned by the bank; cancelled before sending. */
    status: "sending" | "sent" | "returned" | "cancelled";
  }[];
  lines: (VayadaPayoutEntry & {
    /** A card payment's fee in its parts (the plan's fee and vayada Payment's), when they add up. */
    fees: { planMinor: string; vayadaMinor: string; vayadaPercent: number } | null;
    /** The payout a payout line, or its return, belongs to. */
    payoutId: string | null;
  })[];
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
export type ApproveVayadaPayoutAccountCommand = {
  propertyId: string;
  /** The account the operator checked: refused if the hotel replaced it since. */
  destinationId: string;
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

/** The hotel's next payout day and the cut-off it pays to (VAY-2584): the coming Monday (today on a
 * Monday) for stays checked out by the Sunday before; `weeksLater` moves it on by whole weeks. */
export function vayadaNextPayout(today: Date, weeksLater = 0): { on: string; cutoff: string } {
  const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + ((8 - day.getUTCDay()) % 7) + 7 * weeksLater);
  const on = day.toISOString().slice(0, 10);
  day.setUTCDate(day.getUTCDate() - 1);
  return { on, cutoff: day.toISOString().slice(0, 10) };
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
  h.cutoff::text, h.payout_destination_id::text AS "destinationId", d.account_last4 AS "accountLast4",
  to_char(h.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "startedAt",
  h.reference, h.paid_on::text AS "paidOn",
  to_char(h.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "sentAt",
  to_char(h.returned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "returnedAt",
  h.return_reason AS "returnReason"`;

const ACCOUNT_TIMES = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "savedAt",
  to_char(approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "approvedAt"`;

function account(row: {
  id: string;
  revision: number;
  accountLast4: string;
  countryCode: string;
  savedAt: string;
  approvedAt: string | null;
  approvedVia: VayadaPayoutAccount["approvedVia"];
}): VayadaPayoutAccount {
  return {
    id: row.id,
    accountLast4: row.accountLast4,
    countryCode: row.countryCode,
    savedAt: row.savedAt,
    replaced: row.revision > 1,
    approved: row.approvedAt !== null,
    approvedAt: row.approvedAt,
    approvedVia: row.approvedVia,
  };
}

/** vayada Payment payouts for Vayada staff (VAY-2442 P5): what each hotel is owed, its lines and
 * payouts, starting a payout before the money is sent by hand, marking it sent, a payout cancelled
 * or sent back by the bank, and the hotel's bank details to send it to. Live and test-mode money
 * are separate ledgers that never mix. */
export function createVayadaPaymentPayoutRepository(connectionString: string, codec?: Codec) {
  const pool = new pg.Pool({ connectionString, max: 5 });
  // Hotels' own statements (VAY-2584) read on a pool of their own, so owners opening Payouts never
  // queue in front of staff starting or marking payouts.
  const statementPool = new pg.Pool({
    connectionString,
    max: 3,
    connectionTimeoutMillis: 5_000,
    application_name: "vayada-payout-statement",
  });

  /** The account in use. `lock` (a payout start): a replacement saving at the same moment makes
   * the start find no account instead of one being replaced under it. */
  async function destination(queryable: Queryable, propertyId: string, lock = false) {
    return (
      (
        await queryable.query<{
          id: string;
          revision: number;
          ciphertext: Buffer;
          keyArn: string;
          accountLast4: string;
          countryCode: string;
          savedAt: string;
          approvedAt: string | null;
          approvedVia: VayadaPayoutAccount["approvedVia"];
        }>(
          `SELECT id::text, revision, ciphertext, key_arn AS "keyArn", account_last4 AS "accountLast4",
             country_code AS "countryCode", ${ACCOUNT_TIMES}, approved_via AS "approvedVia"
           FROM finance.payout_destinations WHERE property_id=$1::uuid AND enabled
           ${lock ? "FOR SHARE" : ""}`,
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
        revision: number | null;
        accountLast4: string | null;
        countryCode: string | null;
        savedAt: string | null;
        approvedAt: string | null;
        approvedVia: VayadaPayoutAccount["approvedVia"];
        sendingId: string | null;
        sendingAmount: string | null;
        sendingStartedAt: string | null;
        sendingDestinationId: string | null;
        payoutId: string | null;
        payoutAmount: string | null;
        paidOn: string | null;
        reference: string | null;
      }>(
        `WITH balance AS (${BALANCE}
           ${input.propertyId ? "AND l.property_id = $3::uuid" : ""}
           GROUP BY 1, 2, 3)
         SELECT balance.*, d.id::text AS "destinationId", d.revision, d.account_last4 AS "accountLast4",
           d.country_code AS "countryCode",
           to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "savedAt",
           to_char(d.approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "approvedAt",
           d.approved_via AS "approvedVia",
           sending.id::text AS "sendingId", sending.amount_minor::text AS "sendingAmount",
           to_char(sending.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
             AS "sendingStartedAt", sending.payout_destination_id::text AS "sendingDestinationId",
           last.id::text AS "payoutId", last.amount_minor::text AS "payoutAmount",
           last.paid_on::text AS "paidOn", last.reference
         FROM balance
         LEFT JOIN finance.payout_destinations d
           ON d.property_id = balance."propertyId"::uuid AND d.enabled
         LEFT JOIN LATERAL (
           SELECT id, amount_minor, started_at, payout_destination_id FROM finance.hotel_payouts h
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
        row.destinationId && row.revision && row.accountLast4 && row.countryCode && row.savedAt
          ? account({
              id: row.destinationId,
              revision: row.revision,
              accountLast4: row.accountLast4,
              countryCode: row.countryCode,
              savedAt: row.savedAt,
              approvedAt: row.approvedAt,
              approvedVia: row.approvedVia,
            })
          : null,
      sending:
        row.sendingId && row.sendingAmount && row.sendingStartedAt && row.sendingDestinationId
          ? {
              id: row.sendingId,
              amountMinor: row.sendingAmount,
              startedAt: row.sendingStartedAt,
              destinationId: row.sendingDestinationId,
            }
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
      const [balances, entries, payouts, current] = await Promise.all([
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
        destination: current ? account(current) : null,
        entries: entries.rows,
        payouts: payouts.rows,
      };
    },

    /** The hotel's own statement (VAY-2584): live money only, read the same way as `detail`, so
     * every line and payout matches what Vayada staff see; the totals are taken at the hotel's
     * next payout day instead of staff's last cut-off. */
    async statement(input: { propertyId: string; today: Date }): Promise<VayadaPayoutStatement> {
      const [entries, payouts, current] = await Promise.all([
        statementPool.query<
          VayadaPayoutEntry & {
            payoutId: string | null;
            planFee: string | null;
            vayadaFee: string | null;
            vayadaPercent: string | null;
          }
        >(
          `SELECT l.id::text, l.entry_kind AS kind, trim(l.currency) AS currency,
             l.gross_minor::text AS "grossMinor", l.fee_minor::text AS "feeMinor",
             l.net_minor::text AS "netMinor", b.public_reference AS "bookingReference",
             COALESCE(b.check_out, l.stay_check_out)::text AS "checkOut",
             to_char(l.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "occurredAt",
             CASE WHEN l.entry_kind IN ('payout', 'payout_returned')
               THEN split_part(l.source_key, ':', 2) END AS "payoutId",
             CASE WHEN l.entry_kind = 'charge'
               THEN p.payment_metadata->>'platformFeeAmount' END AS "planFee",
             CASE WHEN l.entry_kind = 'charge'
               THEN p.payment_metadata->>'vayadaPaymentFeeAmount' END AS "vayadaFee",
             CASE WHEN l.entry_kind = 'charge'
               THEN p.payment_metadata->>'vayadaPaymentFeePercent' END AS "vayadaPercent"
           FROM finance.hotel_payout_ledger l
           LEFT JOIN booking.guest_bookings b
             ON b.id = l.guest_booking_id AND b.property_id = l.property_id
           LEFT JOIN finance.payments p ON p.id = l.payment_id AND p.property_id = l.property_id
           WHERE l.property_id=$1::uuid AND l.livemode
           ORDER BY l.occurred_at DESC, l.id LIMIT 500`,
          [input.propertyId],
        ),
        statementPool.query<VayadaPayout>(
          `SELECT ${PAYOUT_COLUMNS}
           FROM finance.hotel_payouts h
           JOIN finance.payout_destinations d
             ON d.id = h.payout_destination_id AND d.property_id = h.property_id
           WHERE h.property_id=$1::uuid AND h.livemode
           ORDER BY h.started_at DESC`,
          [input.propertyId],
        ),
        destination(statementPool, input.propertyId),
      ]);
      const statementPayouts = payouts.rows.map((payout) => ({
        id: payout.id,
        currency: payout.currency,
        amountMinor: payout.amountMinor,
        accountLast4: payout.accountLast4,
        startedOn: payout.startedAt.slice(0, 10),
        paidOn: payout.paidOn,
        returnedOn: payout.returnedAt?.slice(0, 10) ?? null,
        status: payout.returnedAt
          ? payout.sentAt
            ? ("returned" as const)
            : ("cancelled" as const)
          : payout.sentAt
            ? ("sent" as const)
            : ("sending" as const),
      }));
      const balancesAt = (next: { cutoff: string }) =>
        hotels(statementPool, {
          livemode: true,
          cutoff: next.cutoff,
          propertyId: input.propertyId,
        });
      const today = input.today.toISOString().slice(0, 10);
      let next = vayadaNextPayout(input.today);
      let balances = await balancesAt(next);
      // On a Monday whose payouts staff have started (or with nothing owed), whatever is still owed
      // goes out the next Monday.
      if (
        next.on === today &&
        (statementPayouts.some(
          (payout) => payout.startedOn === today && payout.status !== "cancelled",
        ) ||
          balances.every((balance) => balance.payNowMinor === "0"))
      ) {
        next = vayadaNextPayout(input.today, 1);
        balances = await balancesAt(next);
      }
      return {
        totals: balances.map((balance) => {
          const sent = statementPayouts.filter(
            (payout) => payout.currency === balance.currency && payout.status === "sent",
          );
          return {
            currency: balance.currency,
            nextPayout: {
              ...next,
              amountMinor: balance.payNowMinor,
              balanceMinor: balance.payableMinor,
            },
            upcomingMinor: balance.upcomingMinor,
            paidOutMinor: sent
              .reduce((sum, payout) => sum + BigInt(payout.amountMinor), 0n)
              .toString(),
            firstPaidOn:
              sent
                .map((payout) => payout.paidOn)
                .filter((day): day is string => day !== null)
                .sort()[0] ?? null,
          };
        }),
        account: current
          ? { accountLast4: current.accountLast4, countryCode: current.countryCode }
          : null,
        payouts: statementPayouts,
        lines: entries.rows.map(({ planFee, vayadaFee, vayadaPercent, ...entry }) => ({
          ...entry,
          fees: chargeFees(entry, planFee, vayadaFee, vayadaPercent),
        })),
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
        const current = await destination(client, command.propertyId, true);
        if (!current) return { status: "no_destination" as const };
        if (current.id !== command.destinationId) return { status: "destination_changed" as const };
        // P7: never to an account Vayada staff haven't approved (a replaced one, until checked).
        if (current.approvedAt === null) return { status: "destination_not_approved" as const };
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
            current.id,
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

    /** P7: Vayada staff approve the hotel's payout account in use after checking it, so payouts
     * can go to it. Only the account the operator checked; approving it again changes nothing. */
    approveDestination(command: ApproveVayadaPayoutAccountCommand) {
      return locked(command.propertyId, async (client) => {
        const approved = (
          await client.query<{ approvedAt: string }>(
            `UPDATE finance.payout_destinations
             SET approved_at=now(), approved_by_user_id=$3::uuid, approved_via='payout_account'
             WHERE id=$1::uuid AND property_id=$2::uuid AND enabled AND deleted_at IS NULL
               AND approved_at IS NULL
             RETURNING to_char(approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
               AS "approvedAt"`,
            [command.destinationId, command.propertyId, command.actorId],
          )
        ).rows[0];
        if (approved) {
          await recordBankTransferAudit(client, {
            propertyId: command.propertyId,
            id: command.destinationId,
            action: "approved",
            actorId: command.actorId,
            auditKey: `approved:${command.destinationId}`,
            kind: "payout_destination",
          });
          return { status: "approved" as const, approvedAt: approved.approvedAt };
        }
        const current = await destination(client, command.propertyId);
        if (!current) return { status: "not_found" as const };
        if (current.id !== command.destinationId) return { status: "destination_changed" as const };
        return { status: "replayed" as const, approvedAt: current.approvedAt! };
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
      const current = await destination(pool, propertyId);
      if (!current) return { status: "not_found" as const };
      if (destinationId && current.id !== destinationId)
        return { status: "destination_changed" as const };
      let details: Awaited<ReturnType<Codec["decrypt"]>>;
      try {
        details = await codec.decrypt(
          { propertyId, id: current.id, revision: current.revision },
          { ciphertext: current.ciphertext, keyArn: current.keyArn },
        );
      } catch {
        return { status: "unavailable" as const };
      }
      await recordBankTransferAudit(pool, {
        propertyId,
        id: current.id,
        action: "revealed",
        actorId,
        auditKey: randomUUID(),
        kind: "payout_destination",
      });
      return {
        status: "revealed" as const,
        destinationId: current.id,
        countryCode: current.countryCode,
        details,
      };
    },

    close: () => Promise.all([pool.end(), statementPool.end()]).then(() => undefined),
  };
}

/** A card payment's fee in its two parts as the payment recorded them (pricingCardPayment): the
 * plan's fee and vayada Payment's. Null for other lines, or when the parts don't add up to the
 * fee the ledger took. */
function chargeFees(
  entry: Pick<VayadaPayoutEntry, "kind" | "currency" | "feeMinor">,
  planFee: string | null,
  vayadaFee: string | null,
  vayadaPercent: string | null,
): VayadaPayoutStatement["lines"][number]["fees"] {
  if (entry.kind !== "charge" || planFee === null || vayadaFee === null || vayadaPercent === null)
    return null;
  try {
    const plan = stripeAmountMinor(planFee, entry.currency);
    const vayada = stripeAmountMinor(vayadaFee, entry.currency);
    const percent = Number(vayadaPercent);
    if (
      !Number.isFinite(percent) ||
      percent < 0 ||
      BigInt(plan + vayada) !== BigInt(entry.feeMinor)
    )
      return null;
    return { planMinor: String(plan), vayadaMinor: String(vayada), vayadaPercent: percent };
  } catch {
    return null;
  }
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
