import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTargetFinancePropertySettingsRepository } from "../routes/finance.js";
import type { PayoutDestinationDetails } from "./financePayoutDestinationCodec.js";
import {
  createPayoutDestinationRepository,
  type PayoutDestinationCommand,
} from "./financePayoutDestinationRepository.js";
import { lockFinanceReplacementPricingSource } from "./financeReplacementPricingSource.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test")) throw new Error("Unsafe test database");
const propertyId = randomUUID(),
  chosen = randomUUID(),
  stripeHotel = randomUUID(),
  upper = randomUUID(),
  actorId = randomUUID();
const properties = [propertyId, chosen, stripeHotel, upper];
const details: PayoutDestinationDetails = {
  accountHolder: "PT Sensitive Holder",
  accountNumber: "0123456789",
  bankName: "Sensitive Bank Indonesia",
  bankCode: "014",
  branchCode: "",
  bicSwift: "CENAIDJA",
  holderAddress: "Jl. Sensitive 1, Ubud",
};
const admin = new pg.Client({ connectionString: url });
const afterCommit = vi.fn<(pool: pg.Pool, propertyId: string) => Promise<null>>(async () => null);
const repository = createPayoutDestinationRepository(
  url ?? "postgresql://disabled",
  {
    async encrypt(_scope, input) {
      const number = (input as PayoutDestinationDetails).accountNumber;
      return { ciphertext: Buffer.alloc(40, 1), keyArn: "key", accountLast4: number.slice(-4) };
    },
  },
  afterCommit,
);
const vayadaAccounts = async (property: string) =>
  (
    await admin.query(
      `SELECT provider_account_id, status, onboarding_status, charges_enabled, payouts_enabled,
         capabilities, card_capability_revision::int AS revision
       FROM finance.payment_provider_accounts WHERE property_id=$1 AND provider='vayada'`,
      [property],
    )
  ).rows;
/** The Finance part of the published prices' fingerprint (VAY-2304). */
const financeSource = (property: string) =>
  lockFinanceReplacementPricingSource(admin as unknown as pg.PoolClient, property);
const settingsPool = new pg.Pool({ connectionString: url ?? "postgresql://disabled" });

beforeAll(async () => {
  if (!url) return;
  await admin.connect();
  await admin.query(
    "INSERT INTO identity.users(id,email,name,status) VALUES ($1,$2,'Test','active')",
    [actorId, `${actorId}@example.test`],
  );
  for (const id of properties)
    await admin.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES ($1::uuid,$1::text,'Test')",
      [id],
    );
  // A hotel that chose vayada Payment in Payments: its settings point at the choice's placeholder.
  // And a hotel on Stripe Connect, whose payment settings point at its Stripe account.
  for (const [property, provider, reference] of [
    [chosen, "vayada", `settings-choice:${chosen}:vayada`],
    [stripeHotel, "stripe", `acct_vay2442${stripeHotel.slice(0, 8)}`],
  ]) {
    const account = await admin.query<{ id: string }>(
      `INSERT INTO finance.payment_provider_accounts (property_id, account_scope, provider,
         provider_account_id, status, onboarding_status, charges_enabled, capabilities)
       VALUES ($1,'property',$2,$3,'active','completed',TRUE,ARRAY['card_payments'])
       RETURNING id::text`,
      [property, provider, reference],
    );
    await admin.query(
      `INSERT INTO finance.payment_settings (property_id, provider_account_id, payments_enabled,
         accepted_methods, default_currency) VALUES ($1,$2,TRUE,ARRAY['card'],'IDR')`,
      [property, account.rows[0]!.id],
    );
  }
});
afterAll(async () => {
  await repository.close();
  await settingsPool.end();
  if (!url) return;
  await admin.query("BEGIN; SET LOCAL session_replication_role=replica");
  for (const table of [
    "platform.product_audit_events",
    "platform.idempotency_keys",
    "finance.payout_destinations",
    "finance.payment_settings",
    "finance.payment_provider_accounts",
  ])
    await admin.query(`DELETE FROM ${table} WHERE property_id=ANY($1::uuid[])`, [properties]);
  await admin.query("DELETE FROM hotel_catalog.properties WHERE id=ANY($1::uuid[])", [properties]);
  await admin.query("DELETE FROM identity.users WHERE id=$1", [actorId]);
  await admin.query("COMMIT");
  await admin.end();
});

it.skipIf(!url)(
  "keeps one encrypted payout account, wipes replaced ones and keeps the vayada account in step",
  async () => {
    const command: PayoutDestinationCommand = {
      propertyId,
      actorId,
      commandId: randomUUID(),
      expectedVersion: 0,
      action: "replace",
      countryCode: "ID",
      details,
    };
    const created = await repository.execute(command);
    expect(created).toMatchObject({
      status: "applied",
      summary: { revision: 1, version: 1, enabled: true, accountLast4: "6789", countryCode: "ID" },
    });
    expect(await vayadaAccounts(propertyId)).toEqual([
      {
        provider_account_id: `vayada:${propertyId}`,
        status: "active",
        onboarding_status: "completed",
        charges_enabled: true,
        payouts_enabled: true,
        capabilities: ["card_payments"],
        revision: 1,
      },
    ]);
    expect(await repository.execute(command)).toMatchObject({ status: "replayed" });
    expect(
      await repository.execute({ ...command, details: { ...details, bankName: "different" } }),
    ).toEqual({ status: "conflict" });

    const replacements = await Promise.all(
      [1, 2].map(() =>
        repository.execute({
          ...command,
          commandId: randomUUID(),
          expectedVersion: 1,
          countryCode: "LK",
          details: { ...details, accountNumber: "9876543210" },
        }),
      ),
    );
    expect(replacements.map((r) => r.status).sort()).toEqual(["applied", "conflict"]);
    expect(await repository.read(propertyId)).toMatchObject({
      revision: 2,
      version: 2,
      accountLast4: "3210",
      countryCode: "LK",
    });
    const revisions = async () =>
      (
        await admin.query(
          `SELECT revision, enabled, ciphertext IS NOT NULL AS stored, deleted_at IS NOT NULL AS deleted
           FROM finance.payout_destinations WHERE property_id=$1 ORDER BY revision`,
          [propertyId],
        )
      ).rows;
    expect(await revisions()).toEqual([
      { revision: 1, enabled: false, stored: false, deleted: true },
      { revision: 2, enabled: true, stored: true, deleted: false },
    ]);
    // A replacement keeps payouts on: Vayada's card approval stays valid.
    expect((await vayadaAccounts(propertyId))[0]).toMatchObject({
      payouts_enabled: true,
      revision: 1,
    });

    const remove = { propertyId, actorId, action: "delete" as const };
    expect(
      await repository.execute({ ...remove, commandId: randomUUID(), expectedVersion: 2 }),
    ).toMatchObject({ status: "applied", summary: { version: 3, deleted: true, enabled: false } });
    expect(await revisions()).toEqual([
      { revision: 1, enabled: false, stored: false, deleted: true },
      { revision: 2, enabled: false, stored: false, deleted: true },
    ]);
    // Removing it turns payouts off, which withdraws any card approval (0119 revision bump).
    expect((await vayadaAccounts(propertyId))[0]).toMatchObject({
      payouts_enabled: false,
      revision: 2,
    });
    expect(
      await repository.execute({ ...remove, commandId: randomUUID(), expectedVersion: 3 }),
    ).toEqual({ status: "conflict" });
    expect(
      await repository.execute({ ...command, commandId: randomUUID(), expectedVersion: 3 }),
    ).toMatchObject({ status: "applied", summary: { revision: 3, version: 4, enabled: true } });
    expect((await vayadaAccounts(propertyId))[0]).toMatchObject({
      payouts_enabled: true,
      revision: 3,
    });
    expect(afterCommit.mock.calls.map(([, id]) => id)).toEqual([
      propertyId,
      propertyId,
      propertyId,
      propertyId,
    ]);

    const audits = (
      await admin.query(
        "SELECT * FROM platform.product_audit_events WHERE property_id=$1 ORDER BY occurred_at",
        [propertyId],
      )
    ).rows;
    expect(audits.map((row) => [row.action, row.target_resource_type])).toEqual(
      ["created", "replaced", "deleted", "replaced"].map((action) => [
        `finance.payout_destination.${action}`,
        "payout_destination",
      ]),
    );
    const retries = (
      await admin.query("SELECT * FROM platform.idempotency_keys WHERE property_id=$1", [
        propertyId,
      ])
    ).rows;
    for (const secret of Object.values(details).filter((value) => value.length > 3))
      expect(JSON.stringify([audits, retries, created])).not.toContain(secret);

    await expect(
      repository.execute({ ...command, commandId: randomUUID(), propertyId: randomUUID() }),
    ).rejects.toThrow(/^Payout destination unavailable\.$/);
  },
);

it.skipIf(!url)(
  "binds the vayada account a hotel already chose, which then shows payouts on",
  async () => {
    const before = await financeSource(chosen);
    await repository.execute({
      propertyId: chosen,
      actorId,
      commandId: randomUUID(),
      expectedVersion: 0,
      action: "replace",
      countryCode: "ID",
      details,
    });
    expect(await vayadaAccounts(chosen)).toEqual([
      expect.objectContaining({
        provider_account_id: `vayada:${chosen}`,
        payouts_enabled: true,
        revision: 1,
      }),
    ]);
    // Its published prices must be re-published: the after-commit call does that (VAY-2304).
    expect(await financeSource(chosen)).not.toBe(before);
    expect(afterCommit).toHaveBeenLastCalledWith(expect.anything(), chosen);
    const settings = await createTargetFinancePropertySettingsRepository({
      connectionString: url!,
      pool: settingsPool,
    }).getPaymentSettings(chosen);
    expect(settings?.paymentProvider).toBe("vayada");
    expect(settings?.providerAccount).toMatchObject({
      providerAccountId: null,
      provider: "vayada",
      payoutsEnabled: true,
    });
  },
);

it.skipIf(!url)(
  "binds vayada:<property> from the stored id, whatever case the request used",
  async () => {
    await repository.execute({
      propertyId: upper.toUpperCase(),
      actorId,
      commandId: randomUUID(),
      expectedVersion: 0,
      action: "replace",
      countryCode: "LK",
      details,
    });
    // The readiness view and the charge compare against 'vayada:'||property_id (VAY-2442 P3).
    expect(await vayadaAccounts(upper)).toEqual([
      expect.objectContaining({ provider_account_id: `vayada:${upper}`, payouts_enabled: true }),
    ]);
  },
);

it.skipIf(!url)("leaves a Stripe Connect hotel's payment settings and prices alone", async () => {
  const before = await financeSource(stripeHotel);
  await repository.execute({
    propertyId: stripeHotel,
    actorId,
    commandId: randomUUID(),
    expectedVersion: 0,
    action: "replace",
    countryCode: "ID",
    details,
  });
  expect(await financeSource(stripeHotel)).toBe(before);
  const bound = await admin.query(
    `SELECT account.provider FROM finance.payment_settings settings
     JOIN finance.payment_provider_accounts account ON account.id = settings.provider_account_id
     WHERE settings.property_id = $1`,
    [stripeHotel],
  );
  expect(bound.rows).toEqual([{ provider: "stripe" }]);
});
