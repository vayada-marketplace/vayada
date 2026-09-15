import type { RequestContext } from "@vayada/backend-auth";
import { describe, expect, it } from "vitest";
import { assentCommandFixture, assentInput } from "./affiliateAssentCommandTestFixture.js";
import { databaseUrl, id } from "./affiliatePublicationTestFixture.js";
import { recordAffiliateAssent } from "./marketplaceAffiliateAssentCommand.js";

describe.skipIf(!databaseUrl)("affiliate initial assent commands", () => {
  const fixture = assentCommandFixture();
  const run = (input = assentInput()) => recordAffiliateAssent(fixture.pool(), input);
  async function counts() {
    const values = [];
    for (const table of [
      "marketplace.affiliate_participations",
      "marketplace.affiliate_participation_attempts",
      "marketplace.affiliate_assent_decisions",
      "platform.idempotency_keys",
    ])
      values.push(
        Number((await fixture.pool().query(`SELECT count(*) FROM ${table}`)).rows[0].count),
      );
    return values;
  }
  it.each([true, false])(
    "records either order and replays original pending result (hotel first: %s)",
    async (hotel) => {
      const first = await run(assentInput(hotel));
      expect(first).toMatchObject({ ok: true, revision: 1, state: "pending", replayed: false });
      const second = await run({ ...assentInput(!hotel), expectedRevision: 1 });
      expect(second).toMatchObject({ ok: true, revision: 2, state: "matched", replayed: false });
      expect(await run(assentInput(hotel))).toEqual({ ...first, replayed: true });
      expect(await counts()).toEqual([1, 1, 2, 2]);
      const rows = (
        await fixture
          .pool()
          .query(
            "SELECT decision,terms_id,actor_user_id,actor_organization_id FROM marketplace.affiliate_assent_decisions ORDER BY revision",
          )
      ).rows;
      expect(rows.map((r) => r.terms_id)).toEqual([id(51), id(51)]);
      expect(rows.map((r) => r.actor_user_id)).toEqual(hotel ? [id(1), id(81)] : [id(81), id(1)]);
      expect(rows.map((r) => r.actor_organization_id)).toEqual(
        hotel ? [id(4), id(80)] : [id(80), id(4)],
      );
    },
  );
  it("rejects changed version or attempt without replacing historical assent", async () => {
    await run();
    for (const change of [{ termsId: id(52) }, { attemptId: id(101) }])
      expect(await run({ ...assentInput(false), expectedRevision: 1, ...change })).toMatchObject({
        ok: false,
        code: "attempt_conflict",
      });
    expect(
      await run({ ...assentInput(false), expectedRevision: 1, disclosureHash: "0".repeat(64) }),
    ).toMatchObject({ ok: false, code: "terms_unavailable" });
    expect(await counts()).toEqual([1, 1, 1, 1]);
  });
  it("rejects unavailable foreign terms and malformed input with no records", async () => {
    for (const termsId of [id(61), id(999)])
      expect(await run({ ...assentInput(), termsId })).toMatchObject({
        ok: false,
        code: "terms_unavailable",
      });
    for (const change of [
      { expectedRevision: -1 },
      { expectedRevision: 2 },
      { expectedRevision: 0.5 },
      { idempotencyKey: " " },
      { attemptId: "invalid" },
    ])
      expect(await run({ ...assentInput(), ...change })).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
    expect(await counts()).toEqual([0, 0, 0, 0]);
  });
  it("serializes concurrent retries and competing opposite decisions", async () => {
    const duplicate = await Promise.all([run(), run()]);
    expect(duplicate.map((r) => r.ok && r.replayed).sort()).toEqual([false, true]);
    const competing = await Promise.all(
      ["a", "b"].map((idempotencyKey) =>
        run({ ...assentInput(false), expectedRevision: 1, idempotencyKey }),
      ),
    );
    expect(competing.filter((r) => r.ok)).toHaveLength(1);
    expect(competing.filter((r) => !r.ok)).toEqual([{ ok: false, code: "revision_conflict" }]);
    expect(await counts()).toEqual([1, 1, 2, 2]);
  });
  it("rejects duplicate side and stale revision without extra writes", async () => {
    await run();
    expect(
      await run({ ...assentInput(), expectedRevision: 1, idempotencyKey: "again" }),
    ).toMatchObject({ ok: false, code: "revision_conflict" });
    expect(await run(assentInput(false))).toMatchObject({ ok: false, code: "revision_conflict" });
    expect(await counts()).toEqual([1, 1, 1, 1]);
  });
  it("conflicts on key reuse with changed actor, revision or terms", async () => {
    await run();
    await fixture.pool().query("INSERT INTO identity.users VALUES ($1)", [id(9)]);
    const other = assentInput();
    other.context.actor.internalUserId = id(9);
    for (const input of [
      other,
      { ...assentInput(), expectedRevision: 1 },
      { ...assentInput(), termsId: id(52) },
    ])
      expect(await run(input)).toMatchObject({ ok: false, code: "idempotency_conflict" });
    expect(await counts()).toEqual([1, 1, 1, 1]);
  });
  it("denies revoked permissions, hotel entitlement and resource/assigned scope before replay", async () => {
    await run();
    const changes: ((c: RequestContext) => void)[] = [
      (c) => {
        c.membership.permissions = [];
      },
      (c) => {
        c.entitlements = [];
      },
      (c) => {
        c.entitlements[0]!.status = "suspended";
      },
      ...["hotel_profile", "marketplace_offer", "property"].map((type) => (c: RequestContext) => {
        c.linkedResources = c.linkedResources.filter((r) => r.resourceType !== type);
      }),
      (c) => {
        c.membership.propertyAccess!.assignedPropertyIds = [id(6)];
      },
    ];
    for (const change of changes) {
      const input = assentInput();
      change(input.context);
      await expect(run(input)).rejects.toThrow();
    }
    for (const field of ["actor", "membership", "selectedOrganization"] as const) {
      const input = assentInput();
      input.context[field].status = "suspended";
      expect(await run(input)).toMatchObject({ ok: false, code: "scope_unavailable" });
    }
    expect(await counts()).toEqual([1, 1, 1, 1]);
  });
  it("rejects foreign tenant, wrong creator owner and ambiguous creator links", async () => {
    const foreign = assentInput();
    foreign.context.selectedOrganization.organizationId = id(7);
    expect(await run(foreign)).toMatchObject({ ok: false, code: "scope_unavailable" });
    const wrongOwner = assentInput(false);
    wrongOwner.context.actor.internalUserId = id(1);
    expect(await run(wrongOwner)).toMatchObject({ ok: false, code: "scope_unavailable" });
    const ambiguous = assentInput(false);
    ambiguous.context.linkedResources.push({
      ...ambiguous.context.linkedResources[0]!,
      resourceId: id(83),
    });
    expect(await run(ambiguous)).toMatchObject({ ok: false, code: "scope_unavailable" });
    const wrongSide = assentInput(false);
    wrongSide.decision = "hotel_approval";
    expect(await run(wrongSide)).toMatchObject({ ok: false, code: "scope_unavailable" });
    expect(await counts()).toEqual([0, 0, 0, 0]);
  });
  it.each([true, false])(
    "rechecks persisted resource ownership before replay (hotel: %s)",
    async (hotel) => {
      const input = assentInput(hotel);
      await run(input);
      await fixture
        .pool()
        .query("UPDATE identity.organization_resource_links SET status='inactive' WHERE id=$1", [
          id(hotel ? 90 : 91),
        ]);
      expect(await run(input)).toMatchObject({ ok: false, code: "scope_unavailable" });
      expect(await counts()).toEqual([1, 1, 1, 1]);
    },
  );
  it("rejects disabled offers and creator profiles before replay", async () => {
    const input = assentInput(false);
    await run(input);
    await fixture
      .pool()
      .query("UPDATE marketplace.marketplace_offers SET offer_status='suspended'");
    expect(await run(input)).toMatchObject({ ok: false, code: "scope_unavailable" });
    await fixture
      .pool()
      .query(
        "UPDATE marketplace.marketplace_offers SET offer_status='verified'; UPDATE marketplace.creator_profiles SET profile_status='suspended'",
      );
    expect(await run(input)).toMatchObject({ ok: false, code: "scope_unavailable" });
    expect(await counts()).toEqual([1, 1, 1, 1]);
  });
  it("checks retained disclosure bytes instead of trusting matching supplied and stored hashes", async () => {
    await fixture.draft(id(23), 3);
    await fixture.pool().query(
      `INSERT INTO marketplace.affiliate_published_terms
      (id,program_id,offer_id,property_id,organization_id,source_draft_id,disclosure,disclosure_hash,
       attribution_policy_version,evidence_references,actor_user_id,request_id,effective_at)
      SELECT $1,program_id,offer_id,property_id,organization_id,$2,'{"different":true}',disclosure_hash,
        attribution_policy_version,evidence_references,actor_user_id,request_id,effective_at
      FROM marketplace.affiliate_published_terms WHERE id=$3`,
      [id(53), id(23), id(51)],
    );
    expect(await run({ ...assentInput(false), termsId: id(53) })).toMatchObject({
      ok: false,
      code: "terms_unavailable",
    });
    expect(await counts()).toEqual([0, 0, 0, 0]);
  });
  it("requires creator write permission and exact owner link before replay without a paid entitlement", async () => {
    const input = assentInput(false);
    expect(input.context.entitlements).toEqual([]);
    expect(await run(input)).toMatchObject({ ok: true });
    const revoked = assentInput(false);
    revoked.context.membership.permissions = [];
    await expect(run(revoked)).rejects.toThrow();
    const missing = assentInput(false);
    missing.context.linkedResources = [];
    await expect(run(missing)).rejects.toThrow();
    expect(await counts()).toEqual([1, 1, 1, 1]);
  });
  it("rolls back participation, attempt and decision when receipt write fails", async () => {
    await fixture.pool()
      .query(`CREATE FUNCTION platform.fail_assent_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$;
      CREATE TRIGGER fail_assent_test BEFORE INSERT ON platform.idempotency_keys FOR EACH ROW EXECUTE FUNCTION platform.fail_assent_test()`);
    await expect(run()).rejects.toThrow("synthetic receipt failure");
    expect(await counts()).toEqual([0, 0, 0, 0]);
    await fixture.pool().query("DROP TRIGGER fail_assent_test ON platform.idempotency_keys");
    expect(await run()).toMatchObject({ ok: true, revision: 1 });
  });
});
