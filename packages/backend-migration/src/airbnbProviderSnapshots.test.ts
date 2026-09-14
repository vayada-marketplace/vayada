import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
describe.skipIf(!databaseUrl)("Airbnb provider snapshots migration", () => {
  const name = `airbnb_snapshot_test_${randomUUID().replaceAll("-", "")}`;
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
    await client.query(`CREATE SCHEMA booking; CREATE SCHEMA finance;
      CREATE TABLE booking.guest_bookings(id uuid,property_id uuid,PRIMARY KEY(id,property_id));
      INSERT INTO booking.guest_bookings VALUES
        ('82000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000002')`);
    const sql = await readFile(
      new URL("../migrations/0193_finance_airbnb_provider_snapshots.sql", import.meta.url),
      "utf8",
    );
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("ROLLBACK");
    expect(
      (await client.query("SELECT to_regclass('finance.airbnb_provider_snapshots') value")).rows[0]
        .value,
    ).toBeNull();
    await client.query(sql);
  });
  afterAll(async () => {
    await client?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  const insert = (
    revision: string,
    at: string,
    days: string[],
    amount: string,
    commission: string,
  ) =>
    client.query(
      `INSERT INTO finance.airbnb_provider_snapshots(property_id,guest_booking_id,provider_property_id,
      provider_booking_id,provider_channel_id,provider_revision_id,provider_revision_at,settings_evidence_ref,
      currency,amount_basis,provider_booking_amount,ota_commission,snapshot)
    VALUES('82000000-0000-4000-8000-000000000002','82000000-0000-4000-8000-000000000001',
      '82000000-0000-4000-8000-000000000003','82000000-0000-4000-8000-000000000004',
      '82000000-0000-4000-8000-000000000005',$1,$2,'test-settings','EUR','Payout Amount',$3,$4,$5)`,
      [
        revision,
        at,
        amount,
        commission,
        JSON.stringify({
          nights: days.map((stayDate) => ({
            roomTypeId: "82000000-0000-4000-8000-000000000006",
            linePosition: 1,
            stayDate,
            providerNightlyAmount: "40.00",
          })),
        }),
      ],
    );

  it("replaces current nights and commission while retaining immutable audit history", async () => {
    await insert(
      "revision-1",
      "2026-09-14T10:00:00.000001Z",
      ["2026-09-01", "2026-09-02", "2026-09-03"],
      "120",
      "12",
    );
    await client.query("BEGIN");
    await insert(
      "revision-2",
      "2026-09-14T10:00:00.000002Z",
      ["2026-09-01", "2026-09-02"],
      "80",
      "8",
    );
    await client.query("ROLLBACK");
    expect(
      (await client.query("SELECT count(*)::int n FROM finance.airbnb_current_provider_nights"))
        .rows[0].n,
    ).toBe(3);
    await insert(
      "revision-2",
      "2026-09-14T10:00:00.000002Z",
      ["2026-09-01", "2026-09-02"],
      "80",
      "8",
    );
    expect(
      (
        await client.query(
          "SELECT stay_date::text,provider_nightly_amount::text,amount_basis FROM finance.airbnb_current_provider_nights ORDER BY stay_date",
        )
      ).rows,
    ).toEqual([
      {
        stay_date: "2026-09-01",
        provider_nightly_amount: "40.0000",
        amount_basis: "Payout Amount",
      },
      {
        stay_date: "2026-09-02",
        provider_nightly_amount: "40.0000",
        amount_basis: "Payout Amount",
      },
    ]);
    expect(
      (
        await client.query(
          "SELECT sum(ota_commission)::text commission,count(*)::int n FROM finance.airbnb_current_provider_amounts",
        )
      ).rows[0],
    ).toEqual({ commission: "8.0000", n: 1 });
    expect(
      (await client.query("SELECT count(*)::int n FROM finance.airbnb_provider_snapshots")).rows[0]
        .n,
    ).toBe(2);
    for (const sql of [
      "DELETE FROM finance.airbnb_provider_snapshots",
      "UPDATE finance.airbnb_provider_snapshots SET ota_commission=0",
      "TRUNCATE finance.airbnb_provider_snapshots",
    ])
      await expect(client.query(sql)).rejects.toMatchObject({ code: "55000" });
    await expect(
      insert("revision-2", "2026-09-14T10:00:01Z", ["2026-09-01"], "40", "4"),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      insert("revision-3", "2026-09-14T10:00:00.000002Z", ["2026-09-01"], "40", "4"),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
