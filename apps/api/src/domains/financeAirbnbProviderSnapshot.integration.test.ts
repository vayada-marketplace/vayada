import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendFinanceAirbnbProviderSnapshot as append } from "./financeAirbnbProviderSnapshot.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
const id = (n: number) => `85000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
describe.skipIf(!databaseUrl)("Airbnb Finance writer (isolated PostgreSQL)", () => {
  const name = `airbnb_writer_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  let pool: pg.Pool;
  beforeAll(async () => {
    if (!/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(databaseUrl!).pathname))
      throw new Error("Refusing non-test database");
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await pool.query(`CREATE SCHEMA booking; CREATE SCHEMA finance;
      CREATE TABLE booking.guest_bookings(id uuid,property_id uuid,source_system text,source_booking_id text,
        booking_channel text,currency text,check_in date,check_out date,room_count int,lifecycle_status text,total_amount numeric,
        PRIMARY KEY(id,property_id));
      INSERT INTO booking.guest_bookings VALUES('${id(1)}','${id(2)}','pms','channex:${id(2)}:${id(3)}',
        'airbnb','EUR','2026-09-01','2026-09-04',1,'confirmed',200)`);
    await pool.query(
      await readFile(
        new URL(
          "../../../../packages/backend-migration/migrations/0216_finance_airbnb_provider_snapshots.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  });
  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });
  const make = (
    revision = "revision-1",
    previous: string | null = null,
    at = "2026-09-14T10:00:00.000001Z",
  ) => ({
    propertyId: id(2),
    bookingId: id(1),
    previousRevisionId: previous,
    providerRevisionAt: at,
    settingsEvidence: {
      providerRevisionId: revision,
      providerChannelId: id(4),
      reference: `settings:${revision}`,
      booking_amount_settings: "Payout Amount" as const,
      cohost_payout_calculations: false,
    },
    revisionScope: {
      revisionId: revision,
      providerPropertyId: id(5),
      providerBookingId: id(3),
      currency: "EUR",
      checkIn: "2026-09-01",
      checkOut: "2026-09-04",
      rooms: [{ providerRoomTypeId: id(6), roomTypeId: id(7) }],
    },
    rawRevision: {
      id: revision,
      property_id: id(5),
      booking_id: id(3),
      ota_name: "Airbnb",
      status: "modified",
      arrival_date: "2026-09-01",
      departure_date: "2026-09-04",
      currency: "EUR",
      amount: "120.00",
      ota_commission: "12.00",
      rooms: [
        {
          room_type_id: id(6),
          amount: "120.00",
          taxes: [],
          days: { "2026-09-01": "40.00", "2026-09-02": "40.00", "2026-09-03": "40.00" },
        },
      ],
    },
  });
  const run = async (
    input: Parameters<typeof append>[1],
    mutate?: (client: pg.PoolClient) => Promise<unknown>,
  ) => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await mutate?.(client);
      const result = await append(client, input);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  it("rejects both repeatable-read competitors before they can append stale successors", async () => {
    const clients = await Promise.all([pool.connect(), pool.connect()]);
    try {
      await Promise.all(
        clients.map(async (client) => {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
          await client.query("SELECT count(*) FROM finance.airbnb_provider_snapshots");
        }),
      );
      const before = (
        await pool.query("SELECT count(*)::int n FROM finance.airbnb_provider_snapshots")
      ).rows[0].n;
      for (const client of clients)
        await expect(append(client, make())).rejects.toThrow(
          "airbnb_finance_transaction_unsupported",
        );
      expect(
        (await pool.query("SELECT count(*)::int n FROM finance.airbnb_provider_snapshots")).rows[0]
          .n,
      ).toBe(before);
    } finally {
      for (const client of clients) {
        await client.query("ROLLBACK");
        client.release();
      }
    }
  });

  it("atomically replaces nightly evidence and commission; exact old replays cannot revive removed nights", async () => {
    const original = make();
    expect((await run(original)).outcome).toBe("appended");
    expect((await run(original)).outcome).toBe("replayed");
    const next = make("revision-2", "revision-1", "2026-09-14T10:00:00.000002Z");
    next.revisionScope.checkOut = next.rawRevision.departure_date = "2026-09-03";
    next.rawRevision.amount = next.rawRevision.rooms[0]!.amount = "80.00";
    next.rawRevision.ota_commission = "8.00";
    Reflect.deleteProperty(next.rawRevision.rooms[0]!.days, "2026-09-03");
    await expect(run(next)).rejects.toThrow("airbnb_finance_booking_stay_mismatch");
    const changeStay = (client: pg.PoolClient) =>
      client.query("UPDATE booking.guest_bookings SET check_out='2026-09-03'");
    const invalid = { ...next, previousRevisionId: "wrong" };
    await expect(run(invalid, changeStay)).rejects.toThrow(
      "airbnb_finance_previous_revision_conflict",
    );
    expect(
      (await pool.query("SELECT check_out::text,total_amount::text FROM booking.guest_bookings"))
        .rows[0],
    ).toEqual({ check_out: "2026-09-04", total_amount: "200" });
    expect((await run(next, changeStay)).outcome).toBe("appended");
    expect(
      (await pool.query("SELECT total_amount::text FROM booking.guest_bookings")).rows[0]
        .total_amount,
    ).toBe("200");
    expect((await run(original)).outcome).toBe("replayed");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n,sum(provider_nightly_amount)::text total FROM finance.airbnb_current_provider_nights",
        )
      ).rows[0],
    ).toEqual({ n: 2, total: "80.0000" });
    expect(
      (
        await pool.query(
          "SELECT ota_commission::text,amount_basis FROM finance.airbnb_current_provider_amounts",
        )
      ).rows[0],
    ).toEqual({ ota_commission: "8.0000", amount_basis: "Payout Amount" });
    const conflicting = { ...next, rawRevision: { ...next.rawRevision, ota_commission: "9.00" } };
    await expect(run(conflicting)).rejects.toThrow("airbnb_finance_revision_conflict");
    await expect(run({ ...next, propertyId: id(9) })).rejects.toThrow(
      "airbnb_finance_booking_scope_unavailable",
    );
    await expect(
      run({ ...next, settingsEvidence: { ...next.settingsEvidence, providerRevisionId: "wrong" } }),
    ).rejects.toThrow("airbnb_finance_settings_revision_mismatch");

    const successor = (revision: string, at: string) => ({
      ...next,
      previousRevisionId: "revision-2",
      providerRevisionAt: at,
      revisionScope: { ...next.revisionScope, revisionId: revision },
      rawRevision: { ...next.rawRevision, id: revision },
      settingsEvidence: {
        ...next.settingsEvidence,
        providerRevisionId: revision,
        reference: `settings:${revision}`,
      },
    });
    for (const at of ["2026-09-14T09:00:00.000000Z", "2026-09-14T10:00:00.000002Z"])
      await expect(run(successor("stale", at))).rejects.toThrow(
        "airbnb_finance_previous_revision_conflict",
      );
    const changedMode = successor("mode-change", "2026-09-14T10:00:00.000003Z");
    await expect(
      run({
        ...changedMode,
        settingsEvidence: {
          ...changedMode.settingsEvidence,
          booking_amount_settings: "Total Paid Amount",
        },
      }),
    ).rejects.toThrow("airbnb_finance_previous_revision_conflict");
    const results = await Promise.allSettled([
      run(successor("revision-3", "2026-09-14T10:00:00.000003Z")),
      run(successor("revision-4", "2026-09-14T10:00:00.000004Z")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      (await pool.query("SELECT count(*)::int n FROM finance.airbnb_provider_snapshots")).rows[0].n,
    ).toBe(3);
    const client = await pool.connect();
    try {
      await expect(append(client, original)).rejects.toThrow(
        "airbnb_finance_booking_scope_unavailable",
      );
    } finally {
      client.release();
    }
  });
  it("cancels atomically with missing room details, preserving unknown commission and history", async () => {
    const previous = (
      await pool.query("SELECT provider_revision_id FROM finance.airbnb_current_provider_amounts")
    ).rows[0].provider_revision_id;
    const base = make("cancel-1", previous, "2026-09-14T11:00:00.000000Z");
    const { rooms: _rooms, ota_commission: _commission, ...raw } = base.rawRevision;
    const cancel = { ...base, rawRevision: { ...raw, status: "cancelled", amount: "25.00" } };
    await expect(run(cancel)).rejects.toThrow("airbnb_finance_booking_stay_mismatch");
    const change = (client: pg.PoolClient) =>
      client.query("UPDATE booking.guest_bookings SET lifecycle_status='canceled'");
    await expect(run({ ...cancel, previousRevisionId: "wrong" }, change)).rejects.toThrow(
      "airbnb_finance_previous_revision_conflict",
    );
    expect(
      (await pool.query("SELECT lifecycle_status FROM booking.guest_bookings")).rows[0]
        .lifecycle_status,
    ).toBe("confirmed");
    expect((await run(cancel, change)).outcome).toBe("appended");
    expect((await run(cancel)).outcome).toBe("replayed");
    expect(
      (await pool.query("SELECT count(*)::int n FROM finance.airbnb_current_provider_nights"))
        .rows[0].n,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT provider_booking_amount::text amount,ota_commission FROM finance.airbnb_current_provider_amounts",
        )
      ).rows[0],
    ).toEqual({ amount: "25.0000", ota_commission: null });
    expect(
      (await pool.query("SELECT count(*)::int n FROM finance.airbnb_provider_snapshots")).rows[0].n,
    ).toBe(4);
    const omitted = {
      ...cancel,
      previousRevisionId: "cancel-1",
      providerRevisionAt: "2026-09-14T11:00:00.000001Z",
      revisionScope: { ...cancel.revisionScope, revisionId: "cancel-2" },
      settingsEvidence: { ...cancel.settingsEvidence, providerRevisionId: "cancel-2" },
      rawRevision: { ...cancel.rawRevision, id: "cancel-2", amount: undefined },
    };
    expect((await run(omitted)).outcome).toBe("appended");
    expect((await run(omitted)).outcome).toBe("replayed");
    expect(
      (
        await pool.query(
          "SELECT provider_booking_amount FROM finance.airbnb_current_provider_amounts",
        )
      ).rows[0].provider_booking_amount,
    ).toBeNull();
    await expect(
      run({ ...omitted, rawRevision: { ...omitted.rawRevision, amount: "0.00" } }),
    ).rejects.toThrow("airbnb_finance_revision_conflict");
  });
});
