import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createReplacementPricingFxStore, lockReplacementPricingFxObservation as verify } from "./replacementPricingFxStore.js";
import { createReplacementPricingFxReader, replacementPricingFxId } from "./replacementPricingFx.js";
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("replacement FX observation PostgreSQL ledger", () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  afterAll(() => pool.end());
  let sequence = 0;
  async function fixture(expirySeconds = 3600, clockSkew = 0) {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1))) throw new Error("test database required");
    const time = Math.floor((await pool.query("SELECT extract(epoch FROM clock_timestamp())::double precision AS time")).rows[0].time);
    const observed = time - 60 + clockSkew, expires = time + expirySeconds + clockSkew;
    const body = JSON.stringify({ result: "success", provider: "https://www.exchangerate-api.com", base_code: "EUR", time_eol_unix: 0,
      time_last_update_unix: observed, time_next_update_unix: expires, rates: { EUR: 1, JPY: 160 + ++sequence, USD: 1.25 } });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(body));
    const dependencies = { fetch: fetcher, now: () => (time + clockSkew) * 1000 };
    const rate = await createReplacementPricingFxReader(dependencies).read("EUR", "JPY");
    fetcher.mockClear();
    return { rate: rate!, body, fetcher, dependencies, store: createReplacementPricingFxStore(pool, dependencies) };
  }
  it("fetches before acquiring a connection and deduplicates concurrent observations across reader instances", async () => {
    const f = await fixture(), connection = vi.spyOn(pool, "connect");
    f.fetcher.mockImplementation(async () => { expect(connection).not.toHaveBeenCalled(); return new Response(f.body); });
    try {
      const result = await Promise.all([f.store.observe("EUR", "JPY"), f.store.observe("EUR", "JPY")]);
      expect(result).toEqual([f.rate, f.rate]); expect(f.fetcher).toHaveBeenCalledTimes(1);
    } finally { connection.mockRestore(); }
    const first = (await pool.query("SELECT * FROM finance.pricing_v2_fx_observations WHERE id=$1", [f.rate.id])).rows[0];
    expect(first).toMatchObject({ numerator: f.rate.numerator, denominator: f.rate.denominator, from_scale: 2, to_scale: 0 });
    expect(first.received_at).toBeInstanceOf(Date);
    expect(await createReplacementPricingFxStore(pool, { fetch: async () => new Response(f.body), now: f.dependencies.now }).observe("EUR", "JPY")).toEqual(f.rate);
    expect((await pool.query("SELECT received_at FROM finance.pricing_v2_fx_observations WHERE id=$1", [f.rate.id])).rows).toEqual([{ received_at: first.received_at }]);
  });
  it("verifies exact pair, content and scales, and rejects malformed or absent IDs", async () => {
    const f = await fixture(); await f.store.observe("EUR", "JPY");
    const client = await pool.connect();
    try {
      expect(await verify(client, f.rate.id, "EUR", "JPY")).toEqual(f.rate);
      for (const [id, from, to] of [[f.rate.id, "EUR", "USD"], [f.rate.id, "JPY", "EUR"], [f.rate.id, "EUR", "EUR"],
        ["missing", "EUR", "JPY"], [`exchange-rate-api:${randomBytes(32).toString("hex")}`, "EUR", "JPY"]])
        expect(await verify(client, id, from, to)).toBeNull();
      const forged = `exchange-rate-api:${randomBytes(32).toString("hex")}`;
      await client.query(`INSERT INTO finance.pricing_v2_fx_observations
        SELECT $1,provider,from_currency,to_currency,numerator,denominator,from_scale,to_scale,observed_at,expires_at,received_at
        FROM finance.pricing_v2_fx_observations WHERE id=$2`, [forged, f.rate.id]);
      expect(await verify(client, forged, "EUR", "JPY")).toBeNull();
      const changed = { ...f.rate, numerator: "17", denominator: "10" }, mismatch = replacementPricingFxId(changed);
      await client.query(`INSERT INTO finance.pricing_v2_fx_observations
        SELECT $1,provider,from_currency,to_currency,'17','10',0,to_scale,observed_at,expires_at,received_at
        FROM finance.pricing_v2_fx_observations WHERE id=$2`, [mismatch, f.rate.id]);
      expect(await verify(client, mismatch, "EUR", "JPY")).toBeNull();
    } finally { client.release(); }
  });
  it("keeps history immutable and enforces ratio/window constraints", async () => {
    const f = await fixture(); await f.store.observe("EUR", "JPY");
    await expect(pool.query("UPDATE finance.pricing_v2_fx_observations SET numerator='1' WHERE id=$1", [f.rate.id])).rejects.toThrow();
    await expect(pool.query("DELETE FROM finance.pricing_v2_fx_observations WHERE id=$1", [f.rate.id])).rejects.toThrow();
    await expect(pool.query("TRUNCATE finance.pricing_v2_fx_observations")).rejects.toThrow();
    for (const [denominator, expires] of [["0", "expires_at"], ["1", "observed_at+INTERVAL '25 hours'"]])
      await expect(pool.query(`INSERT INTO finance.pricing_v2_fx_observations
        SELECT $1,provider,from_currency,to_currency,numerator,$2,from_scale,to_scale,observed_at,${expires},received_at
        FROM finance.pricing_v2_fx_observations WHERE id=$3`, [`exchange-rate-api:${randomBytes(32).toString("hex")}`, denominator, f.rate.id])).rejects.toThrow();
    expect((await pool.query("SELECT numerator FROM finance.pricing_v2_fx_observations WHERE id=$1", [f.rate.id])).rows[0].numerator).toBe(f.rate.numerator);
  });
  it("uses database wall time within a transaction and preserves expired history", async () => {
    const f = await fixture(3); expect(await f.store.observe("EUR", "JPY")).toEqual(f.rate);
    const client = await pool.connect();
    try {
      await client.query("BEGIN"); expect(await verify(client, f.rate.id, "EUR", "JPY")).toEqual(f.rate);
      await client.query("SELECT pg_sleep(3.1)");
      expect(await verify(client, f.rate.id, "EUR", "JPY")).toBeNull();
      expect(await f.store.observe("EUR", "JPY")).toBeNull(); // application clock/cache still thinks it is fresh
      expect((await client.query("SELECT id FROM finance.pricing_v2_fx_observations WHERE id=$1", [f.rate.id])).rowCount).toBe(1);
    } finally { await client.query("ROLLBACK"); client.release(); }
  }, 10_000);
  it("rejects application-clock skew and provider failure without creating an observation", async () => {
    const f = await fixture(3600, 7200);
    expect(await f.store.observe("EUR", "JPY")).toBeNull();
    expect((await pool.query("SELECT id FROM finance.pricing_v2_fx_observations WHERE id=$1", [f.rate.id])).rowCount).toBe(0);
    const connect = vi.spyOn(pool, "connect");
    try {
      expect(await createReplacementPricingFxStore(pool, { fetch: async () => { throw new Error("offline"); } }).observe("EUR", "JPY")).toBeNull();
      expect(connect).not.toHaveBeenCalled();
    } finally { connect.mockRestore(); }
  });
});
