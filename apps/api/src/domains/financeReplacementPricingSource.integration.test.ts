import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { lockFinanceReplacementPricingSource as source } from "./financeReplacementPricingSource.js";
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("independent Finance pricing source", () => {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  afterAll(() => pool.end());
  async function fixture(withSettings = true) {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1))) throw new Error("test database required");
    const propertyId = randomUUID(), accountId = randomUUID(), actorId = randomUUID(), organizationId = randomUUID();
    await pool.query("INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Finance source test')", [propertyId]);
    await pool.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Finance source test')", [actorId, `${actorId}@example.test`]);
    await pool.query("INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Finance source test',$2)", [organizationId, organizationId]);
    await pool.query(`INSERT INTO finance.payment_provider_accounts(id,property_id,account_scope,provider,provider_account_id,status,
      card_capability_revision,account_metadata) VALUES($1,$2,'property','stripe',$3,'active',1,'{}')`, [accountId, propertyId, `acct_synthetic_${accountId}`]);
    const settings = (client: pg.Pool | pg.PoolClient = pool) => client.query(`INSERT INTO finance.payment_settings
      (property_id,provider_account_id,payments_enabled,accepted_methods,default_currency) VALUES($1,$2,true,ARRAY['pay_at_property'],'EUR')`, [propertyId, accountId]);
    // Synthetic acceptance rows test source identity/locking, not actual provider execution.
    async function accept(client: pg.Pool | pg.PoolClient = pool) {
      const id = randomUUID();
      await client.query(`INSERT INTO finance.online_card_execution_evidence
        (id,property_id,provider_account_id,contract_version,test_suite,provider_capability_revision,property_readiness_revision,
          evidence_fingerprint_hash,executed_at,accepted_at,accepted_by_organization_id,accepted_by_user_id)
        SELECT $1,s.property_id,a.id,'finance-online-card-execution-evidence.v1','onb-25a',a.card_capability_revision,
          s.online_card_readiness_revision,$2,clock_timestamp()-interval '1 second',clock_timestamp(),$3,$4
        FROM finance.payment_settings s JOIN finance.payment_provider_accounts a ON a.id=s.provider_account_id WHERE s.property_id=$5`,
      [id, id.replaceAll("-", "").repeat(2), organizationId, actorId, propertyId]);
      return id;
    }
    if (withSettings) await settings();
    return { propertyId, accountId, settings, accept };
  }
  // Source-only tests assume an authorized caller; combined-owner tests exercise actual authorization.
  async function read(propertyId: string, timezone = "UTC") {
    const client = await pool.connect();
    try { await client.query("BEGIN"); await client.query("SELECT set_config('TimeZone',$1,true)", [timezone]); return await source(client, propertyId); }
    finally { await client.query("ROLLBACK"); client.release(); }
  }
  it("is property-scoped and stable without a proposal, including absent/disabled settings", async () => {
    const f = await fixture(false), other = await fixture(false), absent = await read(f.propertyId);
    expect(absent).toMatch(/^finance\.pricing\.source\.v2:[a-f0-9]{64}$/);
    expect(await read(f.propertyId.toUpperCase())).toBe(absent);
    expect(await read(other.propertyId)).not.toBe(absent);
    expect(await read(randomUUID())).toBeNull(); expect(await read("invalid")).toBeNull();
    await f.settings(); const configured = await read(f.propertyId); expect(configured).not.toBe(absent);
    await pool.query("UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1", [f.propertyId]);
    const disabled = await read(f.propertyId); expect(disabled).not.toBe(configured); expect(await read(f.propertyId)).toBe(disabled);
  });
  it("tracks policies, selected provider, capabilities and acceptance/revocation with exact stable values", async () => {
    const f = await fixture(); let previous = await read(f.propertyId);
    for (const value of ["9007199254740992", "9007199254740993"]) {
      await pool.query("UPDATE finance.payment_settings SET tax_policy=$2::jsonb WHERE property_id=$1", [f.propertyId, `{"externalId":${value}}`]);
      const next = await read(f.propertyId); expect(next).not.toBe(previous); previous = next;
    }
    await pool.query("UPDATE finance.payment_settings SET provider_account_id=NULL WHERE property_id=$1", [f.propertyId]);
    const unbound = await read(f.propertyId); expect(unbound).not.toBe(previous);
    await pool.query("UPDATE finance.payment_settings SET provider_account_id=$2 WHERE property_id=$1", [f.propertyId, f.accountId]);
    previous = await read(f.propertyId); expect(previous).not.toBe(unbound);
    await pool.query("UPDATE finance.payment_provider_accounts SET charges_enabled=true WHERE id=$1", [f.accountId]);
    const capability = await read(f.propertyId); expect(capability).not.toBe(previous);
    const evidenceId = await f.accept(), accepted = await read(f.propertyId); expect(accepted).not.toBe(capability);
    expect(await read(f.propertyId, "America/New_York")).toBe(accepted);
    await pool.query("UPDATE finance.payment_settings SET updated_at=clock_timestamp() WHERE property_id=$1", [f.propertyId]);
    await pool.query("UPDATE finance.payment_provider_accounts SET updated_at=clock_timestamp() WHERE id=$1", [f.accountId]);
    expect(await read(f.propertyId)).toBe(accepted);
    await pool.query("UPDATE finance.online_card_execution_evidence SET revoked_at=clock_timestamp() WHERE id=$1", [evidenceId]);
    expect(await read(f.propertyId)).not.toBe(accepted);
  });
  it("protects missing settings and missing execution evidence against insertion", async () => {
    const f = await fixture(false), reader = await pool.connect(), writer = await pool.connect();
    try {
      await writer.query("SET lock_timeout='150ms'");
      await reader.query("BEGIN"); await source(reader, f.propertyId);
      await expect(f.settings(writer)).rejects.toMatchObject({ code: "55P03" });
      await reader.query("COMMIT"); await f.settings(writer);
      await reader.query("BEGIN"); const before = await source(reader, f.propertyId);
      await expect(f.accept(writer)).rejects.toMatchObject({ code: "55P03" });
      await reader.query("COMMIT"); await f.accept(writer);
      expect(await read(f.propertyId)).not.toBe(before);
    } finally {
      await reader.query("ROLLBACK"); await writer.query("RESET lock_timeout"); reader.release(); writer.release();
    }
  });
  it("holds existing settings, selected account and current evidence until transaction end", async () => {
    const f = await fixture(), id = await f.accept(), reader = await pool.connect(), writer = await pool.connect();
    try {
      await writer.query("SET lock_timeout='150ms'"); await reader.query("BEGIN"); await source(reader, f.propertyId);
      for (const [sql, key] of [["UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1", f.propertyId],
        ["UPDATE finance.payment_provider_accounts SET charges_enabled=true WHERE id=$1", f.accountId],
        ["UPDATE finance.online_card_execution_evidence SET revoked_at=clock_timestamp() WHERE id=$1", id]])
        await expect(writer.query(sql, [key])).rejects.toMatchObject({ code: "55P03" });
      await reader.query("COMMIT");
      await writer.query("UPDATE finance.online_card_execution_evidence SET revoked_at=clock_timestamp() WHERE id=$1", [id]);
    } finally {
      await reader.query("ROLLBACK"); await writer.query("RESET lock_timeout"); reader.release(); writer.release();
    }
  });
});
