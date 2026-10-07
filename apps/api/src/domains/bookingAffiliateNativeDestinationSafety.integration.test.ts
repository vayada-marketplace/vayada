import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { affiliateDestinationSafetyLockKey } from "./bookingAffiliateDestinationSafetyLock.js";
import { buildNativeAffiliateArrivalRedirect as read } from "./bookingAffiliateNativeDestinationSafety.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const id = (n: number) => `15040000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const referenceToken = "vc_1234567890123456789012";

describe.skipIf(!databaseUrl)("native affiliate destination safety (PostgreSQL)", () => {
  const name = `vay1504_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  let pool: pg.Pool;

  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(databaseUrl!).pathname.slice(1)))
      throw new Error("Requires a test database");
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await pool.query(`CREATE SCHEMA booking; CREATE SCHEMA hotel_catalog;
      CREATE TABLE hotel_catalog.properties(id UUID PRIMARY KEY, lifecycle_status TEXT, profile_status TEXT);
      CREATE TABLE hotel_catalog.property_slugs(property_id UUID, slug TEXT, purpose TEXT, status TEXT);
      CREATE TABLE hotel_catalog.property_domains(property_id UUID, verification_status TEXT,
        canonical_when_verified BOOLEAN);
      CREATE TABLE booking.affiliate_destination_versions(id UUID PRIMARY KEY, property_id UUID,
        created_by_organization_id UUID, booking_url TEXT);
      INSERT INTO hotel_catalog.properties VALUES ('${id(1)}','active','complete');
      INSERT INTO hotel_catalog.property_slugs VALUES ('${id(1)}','hotel-alpenrose','canonical','active');
      INSERT INTO booking.affiliate_destination_versions VALUES
        ('${id(2)}','${id(1)}','${id(3)}','https://hotel-alpenrose.next-booking.vayada.com/');`);
  });
  afterAll(async () => {
    await pool?.end();
    if (pool) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM hotel_catalog.property_domains");
    await pool.query(
      "UPDATE hotel_catalog.properties SET lifecycle_status='active',profile_status='complete'",
    );
    await pool.query("UPDATE hotel_catalog.property_slugs SET status='active'");
    await pool.query(
      "UPDATE booking.affiliate_destination_versions SET booking_url='https://hotel-alpenrose.next-booking.vayada.com/'",
    );
  });

  const scope = { propertyId: id(1), destinationVersionId: id(2), organizationId: id(3) };
  async function check(input = scope) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const result = await read(client, input, referenceToken);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  it("accepts only the exact current native hotel page and tenant version", async () => {
    expect(await check()).toEqual({
      status: "ready",
      redirectUrl:
        "https://hotel-alpenrose.next-booking.vayada.com/?vref=vc_1234567890123456789012",
      referenceToken,
    });
    expect(await check({ ...scope, organizationId: id(4) })).toEqual({ status: "blocked" });
    expect(await check({ ...scope, propertyId: id(4) })).toEqual({ status: "blocked" });
    expect(await check({ ...scope, destinationVersionId: id(4) })).toEqual({ status: "blocked" });
    expect(await check({ ...scope, destinationVersionId: "not-a-uuid" })).toEqual({
      status: "blocked",
    });

    for (const bookingUrl of [
      "https://external.example/stay",
      "https://hotel-alpenrose.next-booking.vayada.com.evil.example/",
      "https://hotel-alpenrose.next-booking.vayada.com/?next=https://external.example",
      "https://hotel-alpenrose.next-booking.vayada.com/redirect",
      "https://hotel-alpenrose.next-booking.vayada.com:443/",
    ]) {
      await pool.query("UPDATE booking.affiliate_destination_versions SET booking_url=$1", [
        bookingUrl,
      ]);
      expect(await check()).toEqual({ status: "blocked" });
    }
  });

  it("blocks a former native URL after a canonical domain or hotel state changes", async () => {
    await pool.query(`INSERT INTO hotel_catalog.property_domains VALUES ($1,'verified',TRUE)`, [
      id(1),
    ]);
    expect(await check()).toEqual({ status: "blocked" });
    await pool.query("DELETE FROM hotel_catalog.property_domains");
    await pool.query("UPDATE hotel_catalog.properties SET lifecycle_status='suspended'");
    expect(await check()).toEqual({ status: "blocked" });
    await pool.query("UPDATE hotel_catalog.properties SET lifecycle_status='active'");
    await pool.query("UPDATE hotel_catalog.property_slugs SET status='retired'");
    expect(await check()).toEqual({ status: "blocked" });
  });

  it("orders native approval and canonical-domain activation on one property lock", async () => {
    const first = await pool.connect();
    const second = await pool.connect();
    const lockKey = affiliateDestinationSafetyLockKey(scope.propertyId);
    try {
      await first.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      expect(await read(first, scope, referenceToken)).toMatchObject({ status: "ready" });

      await second.query("BEGIN");
      await second.query("SET LOCAL lock_timeout='100ms'");
      await expect(
        second.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lockKey]),
      ).rejects.toMatchObject({ code: "55P03" });
      await second.query("ROLLBACK");
      await first.query("COMMIT");

      await second.query("BEGIN");
      await second.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lockKey]);
      await second.query("INSERT INTO hotel_catalog.property_domains VALUES ($1,'verified',TRUE)", [
        scope.propertyId,
      ]);

      await first.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await first.query("SET LOCAL lock_timeout='100ms'");
      await expect(read(first, scope, referenceToken)).rejects.toMatchObject({ code: "55P03" });
      await first.query("ROLLBACK");
      await second.query("COMMIT");

      await first.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      expect(await read(first, scope, referenceToken)).toEqual({ status: "blocked" });
      await first.query("COMMIT");
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }
  });
});
