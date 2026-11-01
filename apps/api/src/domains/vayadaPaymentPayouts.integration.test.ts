import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createVayadaPaymentPayoutRepository } from "./vayadaPaymentPayouts.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test")) throw new Error("Unsafe test database");
const hotel = randomUUID(),
  noAccount = randomUUID(),
  actorId = randomUUID(),
  destinationId = randomUUID();
const cutoff = "2026-11-08";
const admin = new pg.Client({ connectionString: url });
const decrypt = vi.fn(async () => ({
  accountHolder: "PT Payout Holder",
  accountNumber: "0123456789",
  bankName: "Bank Payout Indonesia",
  bankCode: "014",
  branchCode: "",
  bicSwift: "",
  holderAddress: "",
}));
const repository = createVayadaPaymentPayoutRepository(url ?? "postgresql://disabled", {
  decrypt,
} as never);
let refundHeld = { booking: "", payment: "" };

/** A paid card charge on the ledger for a stay checking out on `checkOut` (now). */
async function charge(input: {
  property: string;
  net: number;
  checkOut: string;
  chargedCheckOut?: string;
  livemode?: boolean;
}) {
  const booking = randomUUID(),
    payment = randomUUID();
  await admin.query(
    `INSERT INTO booking.guest_bookings
       (id,property_id,public_reference,source_system,source_booking_id,lifecycle_status,payment_status,
        check_in,check_out,room_count,currency,total_amount,balance_amount)
     VALUES ($1,$2,$1::uuid::text,'booking',NULL,'confirmed','paid','2026-11-01',$3,1,'IDR',0,0)`,
    [booking, input.property, input.checkOut],
  );
  await admin.query(
    `INSERT INTO finance.payments (id,property_id,guest_booking_id,source_payment_id,payment_kind,
       payment_method,status,amount,currency,visibility_class)
     VALUES ($1,$2,$3,$1::uuid::text,'full','card','paid',$4,'IDR','pms_finance')`,
    [payment, input.property, booking, (input.net * 2) / 100],
  );
  await admin.query(
    `INSERT INTO finance.hotel_payout_ledger (property_id,entry_kind,currency,gross_minor,fee_minor,
       net_minor,guest_booking_id,payment_id,stay_check_out,livemode,source_key,occurred_at)
     VALUES ($1,'charge','IDR',$2,$3,$4,$5,$6,$7,$8,$9,now())`,
    [
      input.property,
      input.net * 2,
      input.net,
      input.net,
      booking,
      payment,
      input.chargedCheckOut ?? input.checkOut,
      input.livemode ?? true,
      `charge:${payment}`,
    ],
  );
  return { booking, payment };
}

beforeAll(async () => {
  if (!url) return;
  await admin.connect();
  await admin.query(
    "INSERT INTO identity.users(id,email,name,status) VALUES ($1,$2,'Finance','active')",
    [actorId, `${actorId}@example.test`],
  );
  await admin.query(
    `INSERT INTO hotel_catalog.properties (id,public_id,display_name)
     VALUES ($1,$1::uuid::text,'Payout Villa'),($2,$2::uuid::text,'No Account Inn')`,
    [hotel, noAccount],
  );
  await admin.query(
    `INSERT INTO finance.payout_destinations
       (id,property_id,revision,state_version,ciphertext,key_arn,account_last4,country_code)
     VALUES ($1,$2,1,1,$3,'key','6789','ID')`,
    [destinationId, hotel, Buffer.alloc(40, 1)],
  );
  // Checked out by Sunday: IDR 1,000,000.50 net, paid in whole rupiah.
  await charge({ property: hotel, net: 100_000_050, checkOut: "2026-11-05" });
  // Charged for the 5th, but the stay moved to the 20th: next weeks.
  await charge({
    property: hotel,
    net: 30_000_000,
    checkOut: "2026-11-20",
    chargedCheckOut: "2026-11-05",
  });
  // Checked out by Sunday, but its refund is still on its way to Stripe: it waits.
  refundHeld = await charge({ property: hotel, net: 4_000_000, checkOut: "2026-11-03" });
  await admin.query(
    `INSERT INTO finance.card_refund_commands (id,property_id,guest_booking_id,payment_id,
       idempotency_key,requested_by,amount,amount_minor,currency,provider_account_ref,
       provider_payment_intent_id)
     VALUES ($1,$2,$3,$4,$1::uuid::text,'guest',80000,8000000,'IDR',$5,'pi_held')`,
    [randomUUID(), hotel, refundHeld.booking, refundHeld.payment, `vayada:${hotel}`],
  );
  // Test-mode money never shows among live money.
  await charge({ property: hotel, net: 7_000_000, checkOut: "2026-11-02", livemode: false });
  await charge({ property: noAccount, net: 5_000_000, checkOut: "2026-11-02" });
});

afterAll(async () => {
  await repository.close();
  if (url) await admin.end();
});

const start = (overrides: Record<string, unknown> = {}) => ({
  propertyId: hotel,
  commandId: randomUUID(),
  livemode: true,
  currency: "IDR",
  cutoff,
  amountMinor: "100000000",
  destinationId,
  actorId,
  ...overrides,
});
const villa = async (livemode = true) =>
  (await repository.list({ livemode, cutoff })).find((row) => row.propertyId === hotel);

it.skipIf(!url)(
  "starts a payout before the money moves, once, then marks it sent (VAY-2442 P5)",
  async () => {
    expect(await villa()).toEqual({
      propertyId: hotel,
      name: "Payout Villa",
      currency: "IDR",
      payableMinor: "100000050",
      payNowMinor: "100000000",
      upcomingMinor: "34000000",
      destination: { id: destinationId, accountLast4: "6789", countryCode: "ID" },
      sending: null,
      lastPayout: null,
    });
    expect(await villa(false)).toMatchObject({ payableMinor: "7000000", upcomingMinor: "0" });

    // Without a payout account there is nowhere to pay; a changed account is refused.
    await expect(
      repository.start(start({ propertyId: noAccount, amountMinor: "5000000" })),
    ).resolves.toEqual({ status: "no_destination" });
    await expect(repository.start(start({ destinationId: randomUUID() }))).resolves.toEqual({
      status: "destination_changed",
    });
    await expect(repository.start(start({ amountMinor: "100000050" }))).resolves.toEqual({
      status: "amount_changed",
      payNowMinor: "100000000",
    });

    // Two operators press "Start" at once: exactly one payout starts.
    const [a, b] = await Promise.all([repository.start(start()), repository.start(start())]);
    const started = [a, b].filter((result) => result.status === "started");
    expect(started).toHaveLength(1);
    expect([a, b]).toContainEqual({ status: "amount_changed", payNowMinor: "0" });
    const payoutId = (started[0] as { payoutId: string }).payoutId;
    expect(await villa()).toMatchObject({
      payableMinor: "50",
      payNowMinor: "0",
      sending: { id: payoutId, amountMinor: "100000000" },
      lastPayout: null,
    });

    await expect(
      repository.markSent({
        propertyId: hotel,
        payoutId,
        reference: "WISE-1",
        paidOn: "2020-01-01",
        actorId,
      }),
    ).resolves.toEqual({ status: "invalid_date" });
    const sent = {
      propertyId: hotel,
      payoutId,
      reference: "WISE-2026-11-09",
      paidOn: "2026-11-09",
      actorId,
    };
    // paid_on before the payout started is refused; "today" here is the database's.
    const today = (await admin.query("SELECT current_date::text AS d")).rows[0].d as string;
    await expect(repository.markSent({ ...sent, paidOn: today })).resolves.toEqual({
      status: "sent",
    });
    await expect(repository.markSent({ ...sent, paidOn: today })).resolves.toEqual({
      status: "replayed",
    });
    await expect(
      repository.markSent({ ...sent, paidOn: today, reference: "OTHER" }),
    ).resolves.toEqual({ status: "conflict" });
    expect(await villa()).toMatchObject({
      sending: null,
      lastPayout: { id: payoutId, amountMinor: "100000000", reference: "WISE-2026-11-09" },
    });

    // The bank sent it back: owed again, once.
    const back = {
      propertyId: hotel,
      payoutId,
      commandId: randomUUID(),
      reason: "Account closed",
      actorId,
    };
    await expect(repository.markReturned(back)).resolves.toEqual({ status: "returned" });
    await expect(repository.markReturned(back)).resolves.toEqual({ status: "replayed" });
    await expect(repository.markReturned({ ...back, commandId: randomUUID() })).resolves.toEqual({
      status: "conflict",
    });
    expect(await villa()).toMatchObject({ payableMinor: "100000050", lastPayout: null });

    // Started, then cancelled before sending: owed again, and it can't be marked sent after.
    const second = await repository.start(start());
    const secondId = (second as { payoutId: string }).payoutId;
    await expect(
      repository.markReturned({
        ...back,
        payoutId: secondId,
        commandId: randomUUID(),
        reason: "Not sent",
      }),
    ).resolves.toEqual({ status: "returned" });
    await expect(
      repository.markSent({ ...sent, payoutId: secondId, paidOn: today }),
    ).resolves.toEqual({ status: "conflict" });
    expect(await villa()).toMatchObject({ payableMinor: "100000050", sending: null });

    const detail = await repository.detail({ propertyId: hotel, livemode: true, cutoff });
    expect(
      detail?.payouts.map((payout) => [payout.id, payout.reference, payout.returnReason]),
    ).toEqual([
      [secondId, null, "Not sent"],
      [payoutId, "WISE-2026-11-09", "Account closed"],
    ]);
    expect(detail?.entries.filter((entry) => entry.kind.startsWith("payout")).length).toBe(4);
    const audits = await admin.query(
      `SELECT action FROM platform.product_audit_events
       WHERE target_resource_id=$1 ORDER BY action`,
      [payoutId],
    );
    expect(audits.rows.map((row) => row.action)).toEqual([
      "finance.vayada_payout.returned",
      "finance.vayada_payout.sent",
      "finance.vayada_payout.started",
    ]);
  },
);

it.skipIf(!url)("never changes what a payout was, and keeps it", async () => {
  const third = await repository.start(start());
  const id = (third as { payoutId: string }).payoutId;
  for (const change of [
    "amount_minor=1",
    "payout_destination_id=gen_random_uuid()",
    "started_at=now() - interval '1 day'",
  ])
    await expect(
      admin.query(`UPDATE finance.hotel_payouts SET ${change} WHERE id=$1`, [id]),
    ).rejects.toMatchObject({ code: "55000" });
  await admin.query(
    `UPDATE finance.hotel_payouts SET reference='R', paid_on=current_date, sent_by_user_id=$2,
       sent_at=now() WHERE id=$1`,
    [id, actorId],
  );
  await expect(
    admin.query("UPDATE finance.hotel_payouts SET reference='OTHER' WHERE id=$1", [id]),
  ).rejects.toMatchObject({ code: "55000" });
  await expect(
    admin.query("DELETE FROM finance.hotel_payouts WHERE id=$1", [id]),
  ).rejects.toMatchObject({ code: "55000" });
});

it.skipIf(!url)("shows the hotel's bank details to send to, and audits every look", async () => {
  await expect(repository.revealDestination(hotel, actorId, destinationId)).resolves.toMatchObject({
    status: "revealed",
    destinationId,
    countryCode: "ID",
    details: { accountNumber: "0123456789" },
  });
  expect(decrypt).toHaveBeenCalledWith(
    { propertyId: hotel, id: destinationId, revision: 1 },
    { ciphertext: expect.any(Buffer), keyArn: "key" },
  );
  await expect(repository.revealDestination(hotel, actorId, randomUUID())).resolves.toEqual({
    status: "destination_changed",
  });
  await expect(repository.revealDestination(noAccount, actorId)).resolves.toEqual({
    status: "not_found",
  });
  decrypt.mockRejectedValueOnce(new Error("KMS down"));
  await expect(repository.revealDestination(hotel, actorId)).resolves.toEqual({
    status: "unavailable",
  });
  const audits = await admin.query(
    `SELECT action, actor_user_id::text AS actor FROM platform.product_audit_events
     WHERE property_id=$1 AND action LIKE 'finance.payout_destination.%'`,
    [hotel],
  );
  expect(audits.rows).toEqual([{ action: "finance.payout_destination.revealed", actor: actorId }]);
});
