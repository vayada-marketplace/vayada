import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createVayadaPaymentPayoutRepository } from "./vayadaPaymentPayouts.js";

// VAY-2584: the hotel's own payout statement reads the same live ledger and payouts as Vayada
// staff's view, and nothing else: no test-mode money, no other hotel's lines.
const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test")) throw new Error("Unsafe test database");
const hotel = randomUUID(),
  otherHotel = randomUUID(),
  mondayHotel = randomUUID(),
  mondayDestination = randomUUID(),
  actorId = randomUUID(),
  destinationId = randomUUID();
const admin = new pg.Client({ connectionString: url });
const repository = createVayadaPaymentPayoutRepository(url ?? "postgresql://disabled");
const ids = {
  chargeA: "",
  chargeB: "",
  testCharge: "",
  otherCharge: "",
  p1: randomUUID(),
  p2: randomUUID(),
  p3: randomUUID(),
  p4: randomUUID(),
  testPayout: randomUUID(),
};

async function booking(property: string, checkOut: string) {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO booking.guest_bookings
       (id,property_id,public_reference,source_system,source_booking_id,lifecycle_status,payment_status,
        check_in,check_out,room_count,currency,total_amount,balance_amount)
     VALUES ($1,$2,$3,'booking',NULL,'confirmed','paid','2026-11-01',$4,1,'IDR',0,0)`,
    [id, property, `VAY-${id.slice(0, 8).toUpperCase()}`, checkOut],
  );
  return id;
}

/** A line on the ledger; a charge also gets its booking and payment. */
async function line(input: {
  property?: string;
  kind: string;
  gross: number;
  fee?: number;
  at: string;
  checkOut?: string;
  livemode?: boolean;
  of?: { booking: string; payment: string };
  metadata?: Record<string, unknown>;
  sourceKey?: string;
}) {
  const property = input.property ?? hotel;
  let of = input.of;
  if (input.kind === "charge") {
    const bookingId = await booking(property, input.checkOut!);
    const payment = randomUUID();
    await admin.query(
      `INSERT INTO finance.payments (id,property_id,guest_booking_id,source_payment_id,payment_kind,
         payment_method,status,amount,currency,visibility_class,payment_metadata)
       VALUES ($1,$2,$3,$1::uuid::text,'full','card','paid',$4,'IDR','pms_finance',$5::jsonb)`,
      [payment, property, bookingId, input.gross / 100, JSON.stringify(input.metadata ?? {})],
    );
    of = { booking: bookingId, payment };
  }
  const fee = input.fee ?? 0;
  const result = await admin.query<{ id: string }>(
    `INSERT INTO finance.hotel_payout_ledger (property_id,entry_kind,currency,gross_minor,fee_minor,
       net_minor,guest_booking_id,payment_id,stay_check_out,livemode,source_key,occurred_at)
     VALUES ($1,$2,'IDR',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id::text`,
    [
      property,
      input.kind,
      input.gross,
      fee,
      input.gross - fee,
      of?.booking ?? null,
      of?.payment ?? null,
      input.kind === "charge" ? input.checkOut : null,
      input.livemode ?? true,
      input.sourceKey ?? `${input.kind}:${randomUUID()}`,
      input.at,
    ],
  );
  return { id: result.rows[0]!.id, ...of! };
}

/** A payout as staff left it: started, then perhaps sent, returned by the bank or cancelled. */
async function payout(input: {
  property?: string;
  destination?: string;
  id: string;
  amount: number;
  startedAt: string;
  paidOn?: string;
  returnedAt?: string;
  livemode?: boolean;
}) {
  await admin.query(
    `INSERT INTO finance.hotel_payouts (id,property_id,command_id,currency,amount_minor,livemode,
       cutoff,payout_destination_id,started_by_user_id,started_at,reference,paid_on,sent_by_user_id,
       sent_at,return_command_id,returned_at,returned_by_user_id,return_reason)
     VALUES ($1,$2,$3,'IDR',$4,$5,'2026-11-01',$6,$7,$8::timestamptz,
       CASE WHEN $9::date IS NULL THEN NULL ELSE 'TRX-PRIVATE-REF' END,$9::date,
       CASE WHEN $9::date IS NULL THEN NULL ELSE $7::uuid END,
       CASE WHEN $9::date IS NULL THEN NULL ELSE $8::timestamptz END,
       CASE WHEN $10::timestamptz IS NULL THEN NULL ELSE gen_random_uuid() END,$10::timestamptz,
       CASE WHEN $10::timestamptz IS NULL THEN NULL ELSE $7::uuid END,
       CASE WHEN $10::timestamptz IS NULL THEN NULL ELSE 'staff-only reason' END)`,
    [
      input.id,
      input.property ?? hotel,
      randomUUID(),
      input.amount,
      input.livemode ?? true,
      input.destination ?? destinationId,
      actorId,
      input.startedAt,
      input.paidOn ?? null,
      input.returnedAt ?? null,
    ],
  );
  await line({
    property: input.property,
    kind: "payout",
    gross: -input.amount,
    at: input.startedAt,
    livemode: input.livemode,
    sourceKey: `payout:${input.id}`,
  });
  if (input.returnedAt)
    await line({
      property: input.property,
      kind: "payout_returned",
      gross: input.amount,
      at: input.returnedAt,
      livemode: input.livemode,
      sourceKey: `payout_returned:${input.id}`,
    });
}

beforeAll(async () => {
  if (!url) return;
  await admin.connect();
  await admin.query(
    `INSERT INTO hotel_catalog.properties (id,public_id,display_name)
     VALUES ($1,$1::uuid::text,'Statement Villa'),($2,$2::uuid::text,'Other Inn'),
       ($3,$3::uuid::text,'Monday Lodge')`,
    [hotel, otherHotel, mondayHotel],
  );
  await admin.query(
    `INSERT INTO finance.payout_destinations
       (id,property_id,revision,state_version,ciphertext,key_arn,account_last4,country_code)
     VALUES ($1,$2,1,1,$3,'key','6789','ID'),($4,$5,1,1,$3,'key','4321','LK')`,
    [destinationId, hotel, Buffer.alloc(40, 1), mondayDestination, mondayHotel],
  );
  // Monday Lodge: IDR 1,000,000 owed for a stay that checked out on 10 Nov; staff paid 600,000 of
  // it on Monday 16 Nov, so 400,000 is still owed.
  await line({
    property: mondayHotel,
    kind: "charge",
    gross: 100_000_000,
    at: "2026-11-08T08:00:00Z",
    checkOut: "2026-11-10",
  });
  await payout({
    property: mondayHotel,
    destination: mondayDestination,
    id: randomUUID(),
    amount: 60_000_000,
    startedAt: "2026-11-16T09:00:00Z",
    paidOn: "2026-11-16",
  });
  // IDR 3,200,000 paid by card; fees: the plan's IDR 256,000 and vayada Payment's 6% (192,000).
  const a = await line({
    kind: "charge",
    gross: 320_000_000,
    fee: 44_800_000,
    at: "2026-11-24T08:00:00Z",
    checkOut: "2026-11-28",
    metadata: {
      platformFeeAmount: "256000.00",
      vayadaPaymentFeeAmount: "192000.00",
      vayadaPaymentFeePercent: 6,
    },
  });
  ids.chargeA = a.id;
  // Part of it refunded: the plan's fee on it comes back.
  await line({
    kind: "refund",
    gross: -150_000_000,
    fee: -12_000_000,
    at: "2026-11-24T12:00:00Z",
    of: a,
  });
  // Checks out after next Sunday: upcoming.
  ids.chargeB = (
    await line({
      kind: "charge",
      gross: 200_000_000,
      at: "2026-11-20T08:00:00Z",
      checkOut: "2026-12-05",
    })
  ).id;
  // Checked out, then disputed and lost after Vayada answered it.
  const d = await line({
    kind: "charge",
    gross: 240_000_000,
    at: "2026-11-05T08:00:00Z",
    checkOut: "2026-11-10",
  });
  await line({
    kind: "dispute",
    gross: -240_000_000,
    fee: 40_500_000,
    at: "2026-11-21T08:00:00Z",
    of: d,
  });
  await line({ kind: "dispute_fee", gross: 0, fee: 40_500_000, at: "2026-11-22T08:00:00Z", of: d });
  // IDR 1,000,000.50 checking out this week: the half rupiah waits.
  await line({
    kind: "charge",
    gross: 100_000_050,
    at: "2026-11-25T01:00:00Z",
    checkOut: "2026-11-27",
  });
  await payout({
    id: ids.p2,
    amount: 50_000_000,
    startedAt: "2026-11-09T09:00:00Z",
    paidOn: "2026-11-09",
    returnedAt: "2026-11-12T09:00:00Z",
  });
  await payout({
    id: ids.p1,
    amount: 100_000_000,
    startedAt: "2026-11-16T09:00:00Z",
    paidOn: "2026-11-16",
  });
  await payout({
    id: ids.p3,
    amount: 30_000_000,
    startedAt: "2026-11-23T09:00:00Z",
    returnedAt: "2026-11-23T10:00:00Z",
  });
  await payout({ id: ids.p4, amount: 20_000_000, startedAt: "2026-11-23T11:00:00Z" });
  // Test-mode money and another hotel's money never show.
  ids.testCharge = (
    await line({
      kind: "charge",
      gross: 999_000_000,
      at: "2026-11-24T09:00:00Z",
      checkOut: "2026-11-10",
      livemode: false,
    })
  ).id;
  await payout({
    id: ids.testPayout,
    amount: 1_000_000,
    startedAt: "2026-11-24T10:00:00Z",
    paidOn: "2026-11-24",
    livemode: false,
  });
  ids.otherCharge = (
    await line({
      property: otherHotel,
      kind: "charge",
      gross: 50_000_000,
      at: "2026-11-24T09:00:00Z",
      checkOut: "2026-11-10",
    })
  ).id;
});

afterAll(async () => {
  await repository.close();
  if (url) await admin.end();
});

const expectedTotals = {
  currency: "IDR",
  nextPayout: {
    on: "2026-11-30",
    cutoff: "2026-11-29",
    amountMinor: "36200000",
    balanceMinor: "36200050",
  },
  upcomingMinor: "200000000",
  // Sent and not returned: only the 16 Nov payout.
  paidOutMinor: "100000000",
  firstPaidOn: "2026-11-16",
};

it.skipIf(!url)(
  "shows the hotel its live payouts and every line, as Vayada staff see them (VAY-2584)",
  async () => {
    const statement = await repository.statement({
      propertyId: hotel,
      today: new Date("2026-11-25T10:00:00Z"),
    });
    expect(statement.totals).toEqual([expectedTotals]);
    expect(statement.account).toEqual({ accountLast4: "6789", countryCode: "ID" });
    expect(
      statement.payouts.map((p) => [p.id, p.status, p.startedOn, p.paidOn, p.returnedOn]),
    ).toEqual([
      [ids.p4, "sending", "2026-11-23", null, null],
      [ids.p3, "cancelled", "2026-11-23", null, "2026-11-23"],
      [ids.p1, "sent", "2026-11-16", "2026-11-16", null],
      [ids.p2, "returned", "2026-11-09", "2026-11-09", "2026-11-12"],
    ]);
    // Staff-only details stay out: transfer references, return reasons, account approval.
    const body = JSON.stringify(statement);
    for (const hidden of ["TRX-PRIVATE-REF", "staff-only reason", destinationId, ids.testPayout])
      expect(body).not.toContain(hidden);

    expect(statement.lines).toHaveLength(13);
    expect(statement.lines.map((l) => l.id)).not.toContain(ids.testCharge);
    expect(statement.lines.map((l) => l.id)).not.toContain(ids.otherCharge);
    const charge = statement.lines.find((l) => l.id === ids.chargeA)!;
    expect(charge).toMatchObject({
      kind: "charge",
      grossMinor: "320000000",
      feeMinor: "44800000",
      netMinor: "275200000",
      checkOut: "2026-11-28",
      fees: { planMinor: "25600000", vayadaMinor: "19200000", vayadaPercent: 6 },
      payoutId: null,
    });
    expect(charge.bookingReference).toMatch(/^VAY-/);
    expect(statement.lines.find((l) => l.id === ids.chargeB)!.fees).toBeNull();
    expect(statement.lines.find((l) => l.kind === "refund")).toMatchObject({
      grossMinor: "-150000000",
      feeMinor: "-12000000",
      netMinor: "-138000000",
      checkOut: "2026-11-28",
      fees: null,
    });
    expect(statement.lines.find((l) => l.kind === "dispute_fee")).toMatchObject({
      grossMinor: "0",
      feeMinor: "40500000",
      netMinor: "-40500000",
    });
    expect(
      statement.lines
        .filter((l) => l.payoutId)
        .map((l) => [l.kind, l.payoutId, l.netMinor])
        .sort(),
    ).toEqual(
      [
        ["payout", ids.p4, "-20000000"],
        ["payout_returned", ids.p3, "30000000"],
        ["payout", ids.p3, "-30000000"],
        ["payout", ids.p1, "-100000000"],
        ["payout_returned", ids.p2, "50000000"],
        ["payout", ids.p2, "-50000000"],
      ].sort(),
    );

    // Every line and payout is the one Vayada Admin shows for the hotel's live money.
    const staff = await repository.detail({
      propertyId: hotel,
      livemode: true,
      cutoff: "2026-11-22",
    });
    expect(statement.lines.map(({ fees: _fees, payoutId: _payout, ...entry }) => entry)).toEqual(
      staff!.entries,
    );
    expect(statement.payouts.map((p) => [p.id, p.amountMinor, p.accountLast4])).toEqual(
      staff!.payouts.map((p) => [p.id, p.amountMinor, p.accountLast4]),
    );
  },
);

it.skipIf(!url)(
  "on a Monday whose payout went out, the next one is a week later; nothing for an unknown hotel",
  async () => {
    // Monday 23 Nov: nothing is owed for stays checked out by Sunday 22 Nov (the payouts took it).
    const monday = await repository.statement({
      propertyId: hotel,
      today: new Date("2026-11-23T12:00:00Z"),
    });
    expect(monday.totals).toEqual([expectedTotals]);
    expect(
      await repository.statement({
        propertyId: randomUUID(),
        today: new Date("2026-11-25T10:00:00Z"),
      }),
    ).toEqual({ totals: [], account: null, payouts: [], lines: [] });
  },
);

it.skipIf(!url)(
  "what is still owed after a Monday's payouts goes out the next Monday, not today",
  async () => {
    const totals = async (today: string) =>
      (await repository.statement({ propertyId: mondayHotel, today: new Date(today) })).totals[0]!
        .nextPayout;
    // Monday 16 Nov, after staff started that day's payout: the rest waits a week.
    expect(await totals("2026-11-16T15:00:00Z")).toEqual({
      on: "2026-11-23",
      cutoff: "2026-11-22",
      amountMinor: "40000000",
      balanceMinor: "40000000",
    });
    // Monday 23 Nov, before staff start: it goes out today.
    expect(await totals("2026-11-23T06:00:00Z")).toEqual({
      on: "2026-11-23",
      cutoff: "2026-11-22",
      amountMinor: "40000000",
      balanceMinor: "40000000",
    });
  },
);
