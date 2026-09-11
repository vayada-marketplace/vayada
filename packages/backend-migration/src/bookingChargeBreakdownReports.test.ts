import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
const migration = await readFile(
  new URL("../migrations/0187_booking_charge_breakdown_reports.sql", import.meta.url),
  "utf8",
);
const platform = await readFile(
  new URL("../migrations/0010_platform_jobs_events_audit.sql", import.meta.url),
  "utf8",
);
const id = (n: number) => `15110000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe.skipIf(!databaseUrl)("unverified charge report storage (PostgreSQL)", () => {
  const name = `vay1511_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  let client: pg.Client;
  beforeAll(async () => {
    assertSafeTestDatabase(databaseUrl!);
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    await client.query(`CREATE SCHEMA booking; CREATE SCHEMA identity; CREATE SCHEMA platform;
      CREATE TABLE identity.users(id UUID PRIMARY KEY);
      CREATE TABLE identity.organizations(id UUID PRIMARY KEY);
      CREATE TABLE booking.guest_bookings(id UUID PRIMARY KEY,property_id UUID NOT NULL,UNIQUE(id,property_id));
      CREATE TABLE booking.original_charge_snapshots(booking_id UUID PRIMARY KEY REFERENCES booking.guest_bookings(id));`);
    await client.query(
      platform.slice(
        platform.indexOf("CREATE FUNCTION platform.prevent_append_only_mutation()"),
        platform.indexOf("CREATE TABLE platform.domain_events ("),
      ),
    );
    await client.query(migration);
    await client.query("INSERT INTO identity.users VALUES($1)", [id(1)]);
    await client.query("INSERT INTO identity.organizations VALUES($1)", [id(2)]);
    await client.query("INSERT INTO booking.guest_bookings VALUES($1,$3),($2,$3),($4,$5)", [
      id(10),
      id(11),
      id(3),
      id(12),
      id(4),
    ]);
    await client.query("INSERT INTO booking.original_charge_snapshots VALUES($1),($2)", [
      id(10),
      id(11),
    ]);
  });
  beforeEach(async () => {
    await client.query("ROLLBACK; BEGIN");
  });
  afterAll(async () => {
    await client?.end();
    if (client) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  function report(overrides: Record<string, string | number | null> = {}) {
    const row = {
      id: id(20),
      booking_id: id(10),
      property_id: id(3),
      contract_version: "booking-charge-report.v1",
      evidence_status: "unverified",
      purpose: "diagnostic",
      environment: "local",
      source_kind: "hotel_reported",
      source_connection: "native-test",
      source_record: "folio-1",
      source_revision: "r1",
      source_contract: "hotel-test.v1",
      reported_charge_reference: "charge-1",
      reported_item_reference: "item-1",
      currency: "EUR",
      minor_unit_scale: 2,
      accommodation_minor: "50000",
      tax_minor: "5000",
      extras_minor: "10000",
      other_minor: "0",
      total_minor: "65000",
      revision: 1,
      supersedes_id: null,
      actor_user_id: id(1),
      organization_id: id(2),
      request_id: "test-report",
      observed_at: "2027-01-01T10:00:00Z",
      ...overrides,
    };
    return client.query(
      `INSERT INTO booking.charge_breakdown_reports (${Object.keys(row).join(",")})
      VALUES (${Object.keys(row)
        .map((_, i) => `$${i + 1}`)
        .join(",")})`,
      Object.values(row),
    );
  }
  async function rejected(overrides: Record<string, string | number | null>, code = "23514") {
    await client.query("SAVEPOINT bad");
    await expect(report(overrides)).rejects.toMatchObject({ code });
    await client.query("ROLLBACK TO SAVEPOINT bad");
  }
  it("stores exact reported components without accepted or payment status", async () => {
    await report();
    const { rows } = await client.query("SELECT * FROM booking.charge_breakdown_reports");
    expect(rows[0]).toMatchObject({
      evidence_status: "unverified",
      accommodation_minor: "50000",
      tax_minor: "5000",
      total_minor: "65000",
    });
    await rejected({ id: id(21), source_revision: "r2", evidence_status: "verified" });
  });
  it("rejects missing, fractional, non-finite, negative, overflowing and unreconciled amounts", async () => {
    for (const amount of ["0.1", "-1", "NaN", "Infinity", "100000000000000000000"]) {
      await rejected({ tax_minor: amount });
    }
    await rejected({ tax_minor: null }, "23502");
    await rejected({ total_minor: "70000" });
    await rejected({ minor_unit_scale: 4 });
    await rejected({ currency: "eur" });
    await report({
      accommodation_minor: "99999999999999999999",
      tax_minor: "0",
      extras_minor: "0",
      total_minor: "99999999999999999999",
    });
  });
  it("requires native evidence, canonical property scope and real reporting identities", async () => {
    await rejected({ property_id: id(4) }, "23503");
    await rejected({ booking_id: id(12), property_id: id(4) }, "23503");
    await rejected({ actor_user_id: id(99) }, "23503");
    await rejected({ actor_user_id: null });
    await rejected({ source_record: "  " });
    await rejected({ purpose: "live", environment: "sandbox" });
  });
  it("uniquely retains a source revision so the owner must resolve replay versus conflict", async () => {
    await report();
    await rejected({ id: id(21) }, "23505");
    await rejected({ id: id(21), tax_minor: "4000", accommodation_minor: "51000" }, "23505");
    expect(
      (await client.query("SELECT count(*) FROM booking.charge_breakdown_reports")).rows[0].count,
    ).toBe("1");
  });
  it("keeps corrections scoped and sequential without branching or replacing history", async () => {
    await report();
    await rejected({ id: id(21), source_revision: "r2", revision: 2 });
    await rejected(
      { id: id(21), source_revision: "r2", revision: 2, supersedes_id: id(20), booking_id: id(11) },
      "23503",
    );
    await rejected(
      { id: id(21), source_revision: "r2", revision: 3, supersedes_id: id(20) },
      "23503",
    );
    await report({
      id: id(21),
      source_revision: "r2",
      revision: 2,
      supersedes_id: id(20),
      tax_minor: "4000",
      accommodation_minor: "51000",
    });
    await rejected(
      { id: id(22), source_revision: "r3", revision: 2, supersedes_id: id(20) },
      "23505",
    );
    const rows = (
      await client.query(
        "SELECT revision,tax_minor FROM booking.charge_breakdown_reports ORDER BY revision",
      )
    ).rows;
    expect(rows).toEqual([
      { revision: 1, tax_minor: "5000" },
      { revision: 2, tax_minor: "4000" },
    ]);
  });
  it("rejects mutation, deletion and truncation", async () => {
    await report();
    for (const sql of [
      "UPDATE booking.charge_breakdown_reports SET tax_minor=tax_minor",
      "DELETE FROM booking.charge_breakdown_reports",
      "TRUNCATE booking.charge_breakdown_reports CASCADE",
    ]) {
      await client.query("SAVEPOINT immutable");
      await expect(client.query(sql)).rejects.toMatchObject({ code: "55000" });
      await client.query("ROLLBACK TO SAVEPOINT immutable");
    }
  });
});
