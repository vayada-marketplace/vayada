import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveMarketplaceAffiliateDraft } from "./marketplaceAffiliateDraftCommand.js";
import { createPgMarketplaceAffiliateDraftRepository } from "./marketplaceAffiliateDraftRepository.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
const id = (n: number) => `15010000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);
const platform = await readFile(new URL("0010_platform_jobs_events_audit.sql", migrations), "utf8");
const drafts = await readFile(
  new URL("0173_marketplace_affiliate_offer_terms_drafts.sql", migrations),
  "utf8",
);
const policies = await readFile(
  new URL("0174_finance_affiliate_percentage_policies.sql", migrations),
  "utf8",
);
const terms = {
  bookingDestinationId: "destination-1",
  financePolicyVersionId: id(10),
  attributionWindowDays: 14,
};
function context(): RequestContext {
  return {
    actor: {
      internalUserId: id(1),
      status: "active",
      email: "test@example.test",
      providerIdentity: { provider: "workos", providerUserId: "user-test" },
    },
    selectedOrganization: { organizationId: id(4), kind: "hotel_group", status: "active" },
    membership: {
      membershipId: id(8),
      status: "active",
      roleKey: "owner",
      workosRoleSlugs: [],
      permissions: ["marketplace.profile.manage"],
    },
    linkedResources: [
      {
        product: "marketplace",
        resourceType: "hotel_profile",
        resourceId: id(3),
        status: "active",
        relationship: "owner",
      },
      {
        product: "marketplace",
        resourceType: "marketplace_offer",
        resourceId: id(2),
        status: "active",
        relationship: "operator",
      },
    ],
    entitlements: [{ product: "marketplace", key: "marketplace-hotel-profile", status: "active" }],
    locale: "en",
    currency: "EUR",
    audit: { requestId: "request-1", source: "api", receivedAt: new Date().toISOString() },
  };
}

describe.skipIf(!databaseUrl)("affiliate draft save (PostgreSQL)", () => {
  const databaseName = `vay1501_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  let pool: pg.Pool;
  let isolatedConnectionString: string;
  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(databaseUrl!).pathname.slice(1)))
      throw new Error("Requires isolated test database");
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const isolatedUrl = new URL(databaseUrl!);
    isolatedUrl.pathname = `/${databaseName}`;
    isolatedConnectionString = isolatedUrl.toString();
    pool = new pg.Pool({ connectionString: isolatedUrl.toString(), max: 3 });
  });
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS marketplace,platform,identity,hotel_catalog,finance CASCADE;
      CREATE SCHEMA finance; CREATE SCHEMA marketplace; CREATE SCHEMA platform; CREATE SCHEMA identity; CREATE SCHEMA hotel_catalog;
      CREATE TABLE identity.users(id UUID PRIMARY KEY);
      CREATE TABLE identity.organizations(id UUID PRIMARY KEY);
      CREATE TABLE hotel_catalog.properties(id UUID PRIMARY KEY);
      CREATE TABLE marketplace.marketplace_offers(id UUID PRIMARY KEY, property_id UUID, organization_id UUID,
        offer_status TEXT DEFAULT 'draft', UNIQUE(id,property_id,organization_id));`);
    await pool.query(
      platform.slice(
        platform.indexOf("CREATE FUNCTION platform.tenant_scope_key("),
        platform.indexOf("CREATE TABLE platform.domain_events ("),
      ),
    );
    await pool.query(
      platform.slice(
        platform.indexOf("CREATE TABLE platform.idempotency_keys ("),
        platform.indexOf("CREATE TABLE platform.dead_letter_events ("),
      ),
    );
    await pool.query(drafts);
    await pool.query(policies);
    await pool.query("INSERT INTO identity.users VALUES ($1);", [id(1)]);
    await pool.query("INSERT INTO identity.organizations VALUES ($1)", [id(4)]);
    await pool.query("INSERT INTO hotel_catalog.properties VALUES ($1),($2)", [id(3), id(6)]);
    await policy(id(10), id(3), 1250, true);
    await pool.query(
      "INSERT INTO marketplace.marketplace_offers(id,property_id,organization_id) VALUES($1,$2,$3)",
      [id(2), id(3), id(4)],
    );
  });
  afterAll(async () => {
    await pool?.end();
    if (pool) await admin.query(`DROP DATABASE ${databaseName}`);
    await admin.end();
  });
  async function policy(versionId: string, propertyId: string, rate: number, approved: boolean) {
    await pool.query(
      `INSERT INTO finance.affiliate_percentage_policy_versions
      (id,property_id,contract_version,model,revenue_basis,eligibility,rate_basis_points,
       created_by_user_id,created_by_organization_id,request_id)
      VALUES ($1,$2,'finance-affiliate-percentage-policy.v1','percentage',
       'accommodation_excluding_taxes_and_extras','verified_completion',$3,$4,$5,'fixture')`,
      [versionId, propertyId, rate, id(1), id(4)],
    );
    if (approved) await approve(versionId, propertyId);
  }
  async function approve(versionId: string, propertyId: string) {
    await pool.query(
      `INSERT INTO finance.affiliate_percentage_policy_approvals
      (policy_version_id,property_id,approved_by_user_id,approved_by_organization_id,request_id)
      VALUES ($1,$2,$3,$4,'fixture')`,
      [versionId, propertyId, id(1), id(4)],
    );
  }
  const input = () => ({
    context: context(),
    propertyId: id(3),
    offerId: id(2),
    expectedRevision: 0,
    idempotencyKey: "save-1",
    terms,
  });

  it("reads only the latest draft in the requested hotel scope", async () => {
    const repository = createPgMarketplaceAffiliateDraftRepository(isolatedConnectionString);
    try {
      await expect(repository.read(id(4), id(3), id(2))).resolves.toEqual({
        revision: 0,
        draft: null,
      });
      await repository.save(input());
      await repository.save({
        ...input(),
        expectedRevision: 1,
        idempotencyKey: "second",
        terms: { ...terms, attributionWindowDays: 30 },
      });
      await expect(repository.read(id(4), id(3), id(2))).resolves.toMatchObject({
        revision: 2,
        draft: {
          terms: { ...terms, attributionWindowDays: 30 },
          commission: {
            status: "available",
            policyVersionId: id(10),
            policy: {
              percentageRate: "12.50",
              revenueBasis: "accommodation_excluding_taxes_and_extras",
              eligibility: "verified_completion",
            },
          },
        },
      });
      await expect(repository.read(id(99), id(3), id(2))).resolves.toBeNull();
      await expect(repository.read(id(4), id(99), id(2))).resolves.toBeNull();
      await pool.query("UPDATE marketplace.marketplace_offers SET offer_status='archived'");
      await expect(repository.read(id(4), id(3), id(2))).resolves.toBeNull();
    } finally {
      await repository.close();
    }
  });

  it("replays original results after later revisions without another row", async () => {
    const first = await saveMarketplaceAffiliateDraft(pool, input());
    expect(first).toMatchObject({ ok: true, revision: 1, replayed: false });
    await expect(
      saveMarketplaceAffiliateDraft(pool, {
        ...input(),
        idempotencyKey: "save-2",
        expectedRevision: 1,
        terms: { ...terms, attributionWindowDays: 30 },
      }),
    ).resolves.toMatchObject({ ok: true, revision: 2 });
    await expect(saveMarketplaceAffiliateDraft(pool, input())).resolves.toEqual({
      ...first,
      replayed: true,
    });
    expect(
      (await pool.query("SELECT count(*) FROM marketplace.affiliate_offer_terms_drafts")).rows[0]
        .count,
    ).toBe("2");
    await expect(
      saveMarketplaceAffiliateDraft(pool, {
        ...input(),
        terms: { ...terms, attributionWindowDays: 7 },
      }),
    ).resolves.toMatchObject({ code: "idempotency_conflict" });
  });

  it("rejects unavailable policy references without drafts or keys, and permits retry after approval", async () => {
    await policy(id(11), id(3), 2000, false);
    await policy(id(12), id(6), 2000, true);
    for (const financePolicyVersionId of ["policy-1", id(99), id(11), id(12)]) {
      await expect(
        saveMarketplaceAffiliateDraft(pool, {
          ...input(),
          terms: { ...terms, financePolicyVersionId },
        }),
      ).resolves.toEqual({ ok: false, code: "policy_unavailable" });
    }
    for (const table of ["marketplace.affiliate_offer_terms_drafts", "platform.idempotency_keys"])
      expect((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count).toBe("0");
    await approve(id(11), id(3));
    await expect(
      saveMarketplaceAffiliateDraft(pool, {
        ...input(),
        terms: { ...terms, financePolicyVersionId: id(11) },
      }),
    ).resolves.toMatchObject({ ok: true, revision: 1 });
  });

  it("keeps the selected rate until an explicit new revision selects a different approved version", async () => {
    const repository = createPgMarketplaceAffiliateDraftRepository(isolatedConnectionString);
    try {
      const first = await repository.save(input());
      await policy(id(11), id(3), 2000, true);
      await expect(repository.read(id(4), id(3), id(2))).resolves.toMatchObject({
        draft: { commission: { policyVersionId: id(10), policy: { percentageRate: "12.50" } } },
      });
      await repository.save({
        ...input(),
        expectedRevision: 1,
        idempotencyKey: "new-rate",
        terms: { ...terms, financePolicyVersionId: id(11) },
      });
      await expect(repository.read(id(4), id(3), id(2))).resolves.toMatchObject({
        revision: 2,
        draft: { commission: { policyVersionId: id(11), policy: { percentageRate: "20.00" } } },
      });
      expect(
        (
          await pool.query(`SELECT finance_policy_version_id FROM marketplace.affiliate_offer_terms_drafts
        ORDER BY revision`)
        ).rows,
      ).toEqual(
        [id(10), id(11)].map((finance_policy_version_id) => ({ finance_policy_version_id })),
      );
      await expect(repository.save(input())).resolves.toEqual({ ...first, replayed: true });
    } finally {
      await repository.close();
    }
  });

  it("reads historical unresolved drafts as unavailable without selecting an approved replacement", async () => {
    await pool.query(
      `INSERT INTO marketplace.affiliate_offer_terms_drafts
      (id,offer_id,property_id,organization_id,revision,contract_version,booking_destination_id,
       finance_policy_version_id,attribution_window_days,actor_user_id,request_id)
      VALUES ($1,$2,$3,$4,1,'marketplace-affiliate-offer-terms.v1','destination-1','policy-1',14,$5,'historical')`,
      [id(20), id(2), id(3), id(4), id(1)],
    );
    const repository = createPgMarketplaceAffiliateDraftRepository(isolatedConnectionString);
    try {
      await expect(repository.read(id(4), id(3), id(2))).resolves.toMatchObject({
        revision: 1,
        draft: {
          terms: { financePolicyVersionId: "policy-1" },
          commission: { status: "unavailable", reason: "not_found" },
        },
      });
    } finally {
      await repository.close();
    }
  });

  it("propagates Finance storage failures and rolls back instead of saving unresolved terms", async () => {
    await pool.query(
      "ALTER TABLE finance.affiliate_percentage_policy_versions RENAME TO unavailable_test",
    );
    await expect(saveMarketplaceAffiliateDraft(pool, input())).rejects.toThrow();
    expect(
      (await pool.query("SELECT count(*) FROM marketplace.affiliate_offer_terms_drafts")).rows[0]
        .count,
    ).toBe("0");
  });

  it("serializes concurrent edits and duplicate retries", async () => {
    const duplicate = await Promise.all([
      saveMarketplaceAffiliateDraft(pool, input()),
      saveMarketplaceAffiliateDraft(pool, input()),
    ]);
    expect(duplicate.map((r) => r.ok && r.replayed).sort()).toEqual([false, true]);
    const edits = await Promise.all(
      ["edit-a", "edit-b"].map((idempotencyKey) =>
        saveMarketplaceAffiliateDraft(pool, { ...input(), expectedRevision: 1, idempotencyKey }),
      ),
    );
    expect(edits.filter((r) => r.ok)).toHaveLength(1);
    expect(edits.filter((r) => !r.ok)).toEqual([{ ok: false, code: "revision_conflict" }]);
  });

  it("rechecks permission, entitlement and both resource links before replay", async () => {
    await saveMarketplaceAffiliateDraft(pool, input());
    for (const mutate of [
      (c: RequestContext) => {
        c.membership.permissions = [];
      },
      (c: RequestContext) => {
        c.entitlements = [];
      },
      (c: RequestContext) => {
        c.entitlements[0]!.status = "suspended";
      },
      (c: RequestContext) => {
        c.linkedResources = c.linkedResources.slice(0, 1);
      },
      (c: RequestContext) => {
        c.linkedResources = c.linkedResources.slice(1);
      },
    ]) {
      const command = input();
      mutate(command.context);
      await expect(saveMarketplaceAffiliateDraft(pool, command)).rejects.toThrow();
    }
    const command = input();
    command.context.actor.status = "suspended";
    await expect(saveMarketplaceAffiliateDraft(pool, command)).resolves.toMatchObject({
      code: "scope_unavailable",
    });
  });

  it("rejects a different tenant even when its context claims resource access", async () => {
    const command = input();
    command.context.selectedOrganization.organizationId = id(99);
    await expect(saveMarketplaceAffiliateDraft(pool, command)).resolves.toMatchObject({
      code: "scope_unavailable",
    });
    await pool.query("UPDATE marketplace.marketplace_offers SET offer_status='archived'");
    await expect(saveMarketplaceAffiliateDraft(pool, input())).resolves.toMatchObject({
      code: "scope_unavailable",
    });
  });

  it("rolls back draft and audit evidence if idempotency persistence fails", async () => {
    await pool.query(`CREATE FUNCTION platform.fail_draft_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$;
      CREATE TRIGGER fail_draft_test BEFORE INSERT ON platform.idempotency_keys FOR EACH ROW EXECUTE FUNCTION platform.fail_draft_test()`);
    await expect(saveMarketplaceAffiliateDraft(pool, input())).rejects.toThrow("test failure");
    expect(
      (await pool.query("SELECT count(*) FROM marketplace.affiliate_offer_terms_drafts")).rows[0]
        .count,
    ).toBe("0");
  });
  it("rejects invalid terms and revision bounds before writing", async () => {
    for (const override of [
      { expectedRevision: -1 },
      { expectedRevision: 2147483647 },
      { expectedRevision: 1.5 },
      { terms: { ...terms, commissionPercent: 10 } },
    ])
      await expect(
        saveMarketplaceAffiliateDraft(pool, { ...input(), ...override }),
      ).resolves.toMatchObject({ code: "invalid_request" });
  });
});
