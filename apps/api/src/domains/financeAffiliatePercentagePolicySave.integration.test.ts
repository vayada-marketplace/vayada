import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveFinanceAffiliatePercentagePolicyFromMarketplace as save } from "./financeAffiliatePercentagePolicySave.js";
import { approveFinanceAffiliatePercentagePolicyFromMarketplace as approve } from "./financeAffiliatePercentagePolicyApprove.js";
const databaseUrl = process.env["TEST_DATABASE_URL"];
const id = (n: number) => `15100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);
const platform = await readFile(new URL("0010_platform_jobs_events_audit.sql", migrations), "utf8");
const policies = await readFile(
  new URL("0174_finance_affiliate_percentage_policies.sql", migrations),
  "utf8",
);
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
    ],
    entitlements: [{ product: "marketplace", key: "marketplace-hotel-profile", status: "active" }],
    locale: "en",
    currency: "EUR",
    audit: { requestId: "request-1", source: "api", receivedAt: new Date().toISOString() },
  };
}

describe.skipIf(!databaseUrl)("affiliate percentage save (PostgreSQL)", () => {
  const name = `vay1510_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  let pool: pg.Pool;
  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(databaseUrl!).pathname.slice(1)))
      throw new Error("Requires isolated test database");
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
  });
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS finance,platform,identity,hotel_catalog CASCADE;
      CREATE SCHEMA finance; CREATE SCHEMA platform; CREATE SCHEMA identity; CREATE SCHEMA hotel_catalog;
      CREATE TABLE identity.users(id UUID PRIMARY KEY); CREATE TABLE identity.organizations(id UUID PRIMARY KEY);
      CREATE TABLE hotel_catalog.properties(id UUID PRIMARY KEY, profile_status TEXT DEFAULT 'incomplete');
      CREATE TABLE identity.organization_resource_links(id UUID PRIMARY KEY, organization_id UUID, product TEXT,
        resource_type TEXT, resource_id TEXT, status TEXT, relationship TEXT);`);
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
    await pool.query(policies);
    await pool.query("INSERT INTO identity.users VALUES ($1),($2)", [id(1), id(9)]);
    await pool.query("INSERT INTO identity.organizations VALUES ($1),($2)", [id(4), id(5)]);
    await pool.query("INSERT INTO hotel_catalog.properties(id) VALUES ($1),($2)", [id(3), id(6)]);
    await pool.query(
      `INSERT INTO identity.organization_resource_links VALUES ($1,$2,'marketplace','hotel_profile',$3,'active','owner')`,
      [id(7), id(4), id(3)],
    );
  });
  afterAll(async () => {
    await pool?.end();
    if (pool) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const input = () => ({
    context: context(),
    propertyId: id(3),
    idempotencyKey: "save-1",
    policy: { percentageRate: "12.50" },
  });
  const count = async (table: string) =>
    (await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count;
  it("preserves old versions and audit without recording approval", async () => {
    const first = await save(pool, input());
    expect(first).toMatchObject({ ok: true, replayed: false });
    await save(pool, { ...input(), idempotencyKey: "second", policy: { percentageRate: "20" } });
    await expect(save(pool, input())).resolves.toEqual({ ...first, replayed: true });
    const rows = await pool.query(
      `SELECT rate_basis_points,created_by_user_id,created_by_organization_id,request_id FROM finance.affiliate_percentage_policy_versions ORDER BY rate_basis_points`,
    );
    expect(rows.rows).toEqual(
      [1250, 2000].map((rate_basis_points) => ({
        rate_basis_points,
        created_by_user_id: id(1),
        created_by_organization_id: id(4),
        request_id: "request-1",
      })),
    );
    expect(await count("finance.affiliate_percentage_policy_approvals")).toBe("0");
  });
  it("serializes concurrent duplicate requests and rejects changed input or actor", async () => {
    const results = await Promise.all([save(pool, input()), save(pool, input())]);
    expect(results.map((r) => r.ok && r.replayed).sort()).toEqual([false, true]);
    expect(await count("finance.affiliate_percentage_policy_versions")).toBe("1");
    await expect(
      save(pool, { ...input(), policy: { percentageRate: "5" } }),
    ).resolves.toMatchObject({ code: "idempotency_conflict" });
    const other = input();
    other.context.actor.internalUserId = id(9);
    await expect(save(pool, other)).resolves.toMatchObject({ code: "idempotency_conflict" });
  });
  it("rechecks context permission, entitlement and linked access before replay", async () => {
    await save(pool, input());
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
        c.linkedResources = [];
      },
      (c: RequestContext) => {
        c.linkedResources[0]!.status = "suspended";
      },
      (c: RequestContext) => {
        c.linkedResources[0]!.relationship = "front_desk";
      },
    ]) {
      const command = input();
      mutate(command.context);
      await expect(save(pool, command)).rejects.toThrow();
    }
    for (const mutate of [
      (c: RequestContext) => {
        c.actor.status = "suspended";
      },
      (c: RequestContext) => {
        c.membership.status = "inactive";
      },
      (c: RequestContext) => {
        c.selectedOrganization.status = "suspended";
      },
      (c: RequestContext) => {
        c.selectedOrganization.kind = "creator_workspace";
      },
    ]) {
      const command = input();
      mutate(command.context);
      await expect(save(pool, command)).resolves.toMatchObject({ code: "scope_unavailable" });
    }
  });
  it("rejects fabricated tenant access, revoked persisted links and disabled properties", async () => {
    const other = input();
    other.context.selectedOrganization.organizationId = id(5);
    await expect(save(pool, other)).resolves.toMatchObject({ code: "scope_unavailable" });
    const property = input();
    property.propertyId = id(6);
    property.context.linkedResources[0]!.resourceId = id(6);
    await expect(save(pool, property)).resolves.toMatchObject({ code: "scope_unavailable" });
    await save(pool, input());
    await pool.query("UPDATE identity.organization_resource_links SET status='suspended'");
    await expect(save(pool, input())).resolves.toMatchObject({ code: "scope_unavailable" });
    await pool.query("UPDATE identity.organization_resource_links SET status='active'");
    await pool.query("UPDATE hotel_catalog.properties SET profile_status='disabled'");
    await expect(save(pool, input())).resolves.toMatchObject({ code: "scope_unavailable" });
  });
  it("rolls back the policy if idempotency persistence fails", async () => {
    await pool.query(`CREATE FUNCTION platform.fail_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$;
      CREATE TRIGGER fail_test BEFORE INSERT ON platform.idempotency_keys FOR EACH ROW EXECUTE FUNCTION platform.fail_test()`);
    await expect(save(pool, input())).rejects.toThrow("test failure");
    expect(await count("finance.affiliate_percentage_policy_versions")).toBe("0");
  });
  it("rejects invalid rate, scope and request metadata before writes", async () => {
    for (const override of [
      { policy: {} },
      { policy: { percentageRate: "101" } },
      { propertyId: "bad" },
      { idempotencyKey: "" },
    ])
      await expect(save(pool, { ...input(), ...override })).resolves.toMatchObject({
        code: "invalid_request",
      });
    const command = input();
    command.context.audit.requestId = " ";
    await expect(save(pool, command)).resolves.toMatchObject({ code: "invalid_request" });
    expect(await count("finance.affiliate_percentage_policy_versions")).toBe("0");
  });
  async function approvalInput(key = "approve-1") {
    const saved = await save(pool, input());
    if (!saved.ok) throw new Error("Save fixture failed");
    return {
      context: context(),
      propertyId: id(3),
      policyVersionId: saved.policyVersionId,
      idempotencyKey: key,
    };
  }
  it("approves only the chosen version and preserves the original approver on retries", async () => {
    const command = await approvalInput();
    await save(pool, { ...input(), idempotencyKey: "new-rate", policy: { percentageRate: "20" } });
    const result = await approve(pool, command);
    expect(result).toEqual({ ok: true, policyVersionId: command.policyVersionId, replayed: false });
    await expect(approve(pool, command)).resolves.toEqual({ ...result, replayed: true });
    await expect(approve(pool, { ...command, idempotencyKey: "different" })).resolves.toMatchObject(
      { code: "already_approved" },
    );
    const rows = await pool.query(
      "SELECT policy_version_id,approved_by_user_id,approved_by_organization_id,request_id FROM finance.affiliate_percentage_policy_approvals",
    );
    expect(rows.rows).toEqual([
      {
        policy_version_id: command.policyVersionId,
        approved_by_user_id: id(1),
        approved_by_organization_id: id(4),
        request_id: "request-1",
      },
    ]);
  });
  it("serializes approval races and rejects changing version or actor under the same key", async () => {
    const command = await approvalInput();
    const duplicate = await Promise.all([approve(pool, command), approve(pool, command)]);
    expect(duplicate.map((r) => r.ok && r.replayed).sort()).toEqual([false, true]);
    await expect(approve(pool, { ...command, policyVersionId: id(99) })).resolves.toMatchObject({
      code: "idempotency_conflict",
    });
    const other = { ...command, context: context() };
    other.context.actor.internalUserId = id(9);
    await expect(approve(pool, other)).resolves.toMatchObject({ code: "idempotency_conflict" });
    const next = await save(pool, { ...input(), idempotencyKey: "rate-2" });
    if (!next.ok) throw new Error("Save fixture failed");
    const race = await Promise.all(
      ["a", "b"].map((idempotencyKey) =>
        approve(pool, { ...command, policyVersionId: next.policyVersionId, idempotencyKey }),
      ),
    );
    expect(race.filter((r) => r.ok)).toHaveLength(1);
    expect(race.filter((r) => !r.ok)).toEqual([{ ok: false, code: "already_approved" }]);
  });
  it("checks approval access before replay and rejects mismatched property or authoring organization", async () => {
    const command = await approvalInput();
    await expect(approve(pool, { ...command, policyVersionId: id(99) })).resolves.toMatchObject({
      code: "scope_unavailable",
    });
    const other = { ...command, context: context() };
    other.context.selectedOrganization.organizationId = id(5);
    await pool.query("UPDATE identity.organization_resource_links SET organization_id=$1", [id(5)]);
    await expect(approve(pool, other)).resolves.toMatchObject({ code: "scope_unavailable" });
    await pool.query("UPDATE identity.organization_resource_links SET organization_id=$1", [id(4)]);
    await pool.query(
      `INSERT INTO identity.organization_resource_links VALUES ($1,$2,'marketplace','hotel_profile',$3,'active','owner')`,
      [id(10), id(4), id(6)],
    );
    const wrong = { ...command, context: context(), propertyId: id(6) };
    wrong.context.linkedResources[0]!.resourceId = id(6);
    await expect(approve(pool, wrong)).resolves.toMatchObject({ code: "scope_unavailable" });
    await approve(pool, command);
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
        c.linkedResources = [];
      },
      (c: RequestContext) => {
        c.linkedResources[0]!.relationship = "front_desk";
      },
    ]) {
      const denied = { ...command, context: context() };
      mutate(denied.context);
      await expect(approve(pool, denied)).rejects.toThrow();
    }
    const inactive = { ...command, context: context() };
    inactive.context.membership.status = "inactive";
    await expect(approve(pool, inactive)).resolves.toMatchObject({ code: "scope_unavailable" });
    await pool.query("UPDATE identity.organization_resource_links SET status='suspended'");
    await expect(approve(pool, command)).resolves.toMatchObject({ code: "scope_unavailable" });
    await pool.query("UPDATE identity.organization_resource_links SET status='active'");
    await pool.query("UPDATE hotel_catalog.properties SET profile_status='disabled'");
    await expect(approve(pool, command)).resolves.toMatchObject({ code: "scope_unavailable" });
  });
  it("rolls back approval evidence on failed idempotency write, allowing a clean retry", async () => {
    const command = await approvalInput();
    await pool.query(`CREATE FUNCTION platform.fail_approval_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'approval test failure'; END $$;
      CREATE TRIGGER fail_test BEFORE INSERT ON platform.idempotency_keys FOR EACH ROW EXECUTE FUNCTION platform.fail_approval_test()`);
    await expect(approve(pool, command)).rejects.toThrow("approval test failure");
    expect(await count("finance.affiliate_percentage_policy_approvals")).toBe("0");
    await pool.query("DROP TRIGGER fail_test ON platform.idempotency_keys");
    await expect(approve(pool, command)).resolves.toMatchObject({ ok: true, replayed: false });
  });
  it("rejects invalid approval identifiers, keys and audit metadata before writes", async () => {
    const command = await approvalInput();
    for (const change of [
      { policyVersionId: "bad" },
      { propertyId: "bad" },
      { idempotencyKey: " " },
    ])
      await expect(approve(pool, { ...command, ...change })).resolves.toMatchObject({
        code: "invalid_request",
      });
    command.context.audit.requestId = " ";
    await expect(approve(pool, command)).resolves.toMatchObject({ code: "invalid_request" });
    expect(await count("finance.affiliate_percentage_policy_approvals")).toBe("0");
  });
  it("allows an authorized operator and keeps approval retries separate from save keys", async () => {
    const command = await approvalInput("save-1");
    command.context.linkedResources[0]!.relationship = "operator";
    await pool.query("UPDATE identity.organization_resource_links SET relationship='operator'");
    await expect(
      approve(pool, { ...command, policyVersionId: command.policyVersionId.toUpperCase() }),
    ).resolves.toMatchObject({
      ok: true,
      replayed: false,
      policyVersionId: command.policyVersionId,
    });
    await expect(approve(pool, command)).resolves.toMatchObject({ ok: true, replayed: true });
    expect(
      (
        await pool.query(
          "SELECT rate_basis_points FROM finance.affiliate_percentage_policy_versions",
        )
      ).rows,
    ).toEqual([{ rate_basis_points: 1250 }]);
  });
});
