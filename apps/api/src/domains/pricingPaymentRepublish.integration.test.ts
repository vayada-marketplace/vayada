import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { readPricingPublicationFreshness } from "./pricingPublicationFreshness.js";
import { paymentRepublishFixture } from "./pricingPaymentRepublish.fixtures.js";
import { republishPricingAfterPaymentChange } from "./pricingPaymentRepublish.js";

const url = process.env["TEST_DATABASE_URL"];
// VAY-2304: a change to a hotel's payment setup publishes its last published prices again, as the
// system, so its booking page keeps selling without anyone pressing "Save prices".
describe.skipIf(!url)("re-publishing prices after a payment change", () => {
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  afterAll(() => pool.end());

  async function fixture(methods: string[], card = false) {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    return paymentRepublishFixture(pool, methods, card);
  }

  const revisions = async (propertyId: string) =>
    (
      await pool.query(
        `SELECT revision, actor_type, actor_user_id, republished_from, owner_references->>'charges' AS charges
        FROM pms.pricing_v2_revisions WHERE property_id=$1 ORDER BY revision`,
        [propertyId],
      )
    ).rows;
  const rooms = async (propertyId: string, revision: number) =>
    (
      await pool.query(
        "SELECT configuration FROM pms.pricing_v2_rooms WHERE property_id=$1 AND revision=$2 ORDER BY room_type_id",
        [propertyId, revision],
      )
    ).rows.map((row) => row.configuration);

  it("publishes the same prices again as the system after a payment-method change, and they serve", async () => {
    const f = await fixture(["pay_at_property"]),
      id = f.propertyId;
    expect(await (await f.save(0))()).toEqual({ revision: 1, replayed: false });
    const [hotel] = await revisions(id);

    await pool.query(
      "UPDATE finance.payment_settings SET accepted_methods=ARRAY['pay_at_property','paypal'] WHERE property_id=$1",
      [id],
    );
    expect(await readPricingPublicationFreshness(pool, id)).toEqual([
      { propertyId: id, revision: 1, stale: ["finance"] },
    ]);
    expect(await f.served()).toBeNull();
    expect(await f.commands.read(id)).toMatchObject({ revision: 1, stale: true });

    expect(await republishPricingAfterPaymentChange(pool, id)).toEqual({
      propertyId: id,
      outcome: "republished",
      from: 1,
      revision: 2,
    });
    expect(await readPricingPublicationFreshness(pool, id)).toEqual([
      { propertyId: id, revision: 2, stale: [] },
    ]);
    expect(await f.served()).toMatchObject({ publication: { revision: 2 } });
    // PMS Prices and Booking Admin setup drop their "save prices again" box.
    expect(await f.commands.read(id)).toMatchObject({ revision: 2, stale: false });

    const after = await revisions(id);
    expect(after[1]).toMatchObject({
      revision: 2,
      actor_type: "system",
      actor_user_id: null,
      republished_from: 1,
    });
    expect(await rooms(id, 2)).toEqual(
      (await rooms(id, 1)).map((room) => ({ ...room, revision: 2 })),
    );
    // The hotel's charges declaration, carried by the system onto the same prices.
    expect(
      (
        await pool.query(
          "SELECT actor_type, actor_user_id, draft_id, carried_from::text FROM pms.pricing_v2_charge_declarations WHERE id=$1",
          [after[1].charges],
        )
      ).rows,
    ).toEqual([
      { actor_type: "system", actor_user_id: null, draft_id: null, carried_from: hotel.charges },
    ]);
    expect(
      (
        await pool.query(
          `SELECT actor_type, actor_user_id, audit_metadata FROM platform.product_audit_events
          WHERE property_id=$1 AND action='pricing.v2.revised' ORDER BY occurred_at, audit_key`,
          [id],
        )
      ).rows,
    ).toEqual([
      { actor_type: "user", actor_user_id: hotel.actor_user_id, audit_metadata: {} },
      {
        actor_type: "system",
        actor_user_id: null,
        audit_metadata: { republishedFrom: 1, reason: "payment_setup_changed" },
      },
    ]);

    // Nothing left to do: a second run writes nothing.
    expect(await republishPricingAfterPaymentChange(pool, id)).toEqual({
      propertyId: id,
      outcome: "current",
    });
    expect(await revisions(id)).toHaveLength(2);
  });

  it("follows Vayada card off and on again, each time with the methods the hotel can take", async () => {
    const f = await fixture(["card", "pay_at_property"], true),
      id = f.propertyId;
    const approval = await f.cardOn();
    expect(await (await f.save(0))()).toEqual({ revision: 1, replayed: false });
    expect((await f.served())?.finance).toMatchObject({ methods: ["pay_at_property", "card"] });

    await f.cardOff(approval);
    expect(await f.served()).toBeNull();
    expect(await republishPricingAfterPaymentChange(pool, id)).toMatchObject({
      outcome: "republished",
      revision: 2,
    });
    expect((await f.served())?.finance).toMatchObject({ methods: ["pay_at_property"] });

    await f.cardOn();
    expect(await f.served()).toBeNull();
    expect(await republishPricingAfterPaymentChange(pool, id)).toMatchObject({
      outcome: "republished",
      revision: 3,
    });
    expect((await f.served())?.finance).toMatchObject({ methods: ["pay_at_property", "card"] });
    // Every copy points at the hotel's own declaration, not at the copy before it.
    const all = await revisions(id);
    const carried = (
      await pool.query(
        "SELECT carried_from::text FROM pms.pricing_v2_charge_declarations WHERE id = ANY($1::uuid[]) ORDER BY created_at",
        [[all[1].charges, all[2].charges]],
      )
    ).rows.map((row) => row.carried_from);
    expect(carried).toEqual([all[0].charges, all[0].charges]);
  });

  it("never publishes a hotel's unsaved draft, and leaves the draft as it was", async () => {
    const f = await fixture(["pay_at_property"]),
      id = f.propertyId;
    await (
      await f.save(0)
    )();
    // The hotel starts another save at a new price and leaves before publishing.
    await f.save(1, "25000");
    const drafts = async () =>
      (
        await pool.query(
          "SELECT draft_id, draft_revision, base_revision, snapshot FROM pms.pricing_v2_drafts WHERE property_id=$1 ORDER BY draft_id",
          [id],
        )
      ).rows;
    const before = await drafts();
    await pool.query(
      "UPDATE finance.payment_settings SET tax_policy='{\"version\":2}'::jsonb WHERE property_id=$1",
      [id],
    );
    expect(await republishPricingAfterPaymentChange(pool, id)).toMatchObject({
      outcome: "republished",
      revision: 2,
    });
    expect(await rooms(id, 2)).toEqual(
      (await rooms(id, 1)).map((room) => ({ ...room, revision: 2 })),
    );
    expect(JSON.stringify(await rooms(id, 2))).not.toContain("25000");
    expect(await drafts()).toEqual(before);
  });

  it("serializes with the hotel's own save: whichever comes second finds the work done or stale", async () => {
    const f = await fixture(["pay_at_property"]),
      id = f.propertyId;
    await (
      await f.save(0)
    )();
    await pool.query(
      "UPDATE finance.payment_settings SET tax_policy='{\"version\":2}'::jsonb WHERE property_id=$1",
      [id],
    );
    // The hotel saves first: its prices are current, so there is nothing to re-publish.
    expect(await (await f.save(1))()).toEqual({ revision: 2, replayed: false });
    expect(await republishPricingAfterPaymentChange(pool, id)).toEqual({
      propertyId: id,
      outcome: "current",
    });

    await pool.query(
      "UPDATE finance.payment_settings SET tax_policy='{\"version\":3}'::jsonb WHERE property_id=$1",
      [id],
    );
    // The hotel's save is under way when the re-publish lands: its publish finds the prices changed.
    const publish = await f.save(2);
    expect(await republishPricingAfterPaymentChange(pool, id)).toMatchObject({
      outcome: "republished",
      revision: 3,
    });
    await expect(publish()).rejects.toMatchObject({ code: "stale" });

    // A save holding the pricing lock makes the re-publish wait for it.
    await pool.query(
      "UPDATE finance.payment_settings SET tax_policy='{\"version\":4}'::jsonb WHERE property_id=$1",
      [id],
    );
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await lockPmsInventoryMutationScope(holder, id);
      let settled = false;
      const waiting = republishPricingAfterPaymentChange(pool, id).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);
      await holder.query("ROLLBACK");
      expect(await waiting).toMatchObject({ outcome: "republished", revision: 4 });
    } finally {
      holder.release();
    }
  });

  it("leaves it to the hotel when rooms or rate terms changed too, and writes nothing", async () => {
    const f = await fixture(["pay_at_property"]),
      id = f.propertyId;
    await (
      await f.save(0)
    )();
    await pool.query(
      "UPDATE finance.payment_settings SET tax_policy='{\"version\":2}'::jsonb WHERE property_id=$1",
      [id],
    );
    await f.changeTerms();
    expect(await republishPricingAfterPaymentChange(pool, id)).toEqual({
      propertyId: id,
      outcome: "skipped",
      reason: "room_or_terms_changed",
    });
    expect(await revisions(id)).toHaveLength(1);
  });

  it("writes nothing when the new payment setup can't take the prices at all", async () => {
    const f = await fixture(["pay_at_property"]),
      id = f.propertyId;
    await (
      await f.save(0)
    )();
    await pool.query(
      "UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1",
      [id],
    );
    expect(await republishPricingAfterPaymentChange(pool, id)).toEqual({
      propertyId: id,
      outcome: "skipped",
      reason: "finance_unavailable",
      financeReason: "payments_disabled",
    });
    expect(await revisions(id)).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM pms.pricing_v2_charge_declarations WHERE property_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("does nothing for a hotel that never published", async () => {
    const f = await fixture(["pay_at_property"]);
    expect(await republishPricingAfterPaymentChange(pool, f.propertyId)).toEqual({
      propertyId: f.propertyId,
      outcome: "skipped",
      reason: "not_published",
    });
  });
});
