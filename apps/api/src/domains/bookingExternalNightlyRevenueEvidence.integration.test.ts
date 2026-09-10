import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ExternalRevenueEvidenceScopeError,
  appendExternalNightlyRevenueEvidence,
  type AppendExternalRevenueEvidenceCommand,
  type ExternalRevenueEvidenceLine,
} from "./bookingExternalNightlyRevenueEvidence.js";
import { appendExternalNightlyRevenueEconomics } from "./financeOtaCommissionEvidence.js";
import { planOtaRevenueCorrections } from "./bookingOtaRevenueCorrections.js";
import { loadBookingOtaRevenueLedger } from "./bookingOtaRevenueLedger.js";
const DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = randomUUID(),
  OTA_BOOKING = randomUUID(),
  DIRECT_BOOKING = randomUUID(),
  ROOM_TYPE = randomUUID();
const OTHER_PROPERTY = randomUUID(),
  OTHER_ROOM_TYPE = randomUUID();
const OTA_REFERENCE = `external:${randomUUID()}`;

describe.skipIf(!DATABASE_URL)("external nightly revenue evidence (PostgreSQL)", () => {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  const peers: pg.Client[] = [];
  const line = (
    stayDate: string,
    grossRoomAmount: string | null,
    evidenceQuality: "exact" | "inferred" | "missing",
    overrides: Partial<ExternalRevenueEvidenceLine> = {},
  ): ExternalRevenueEvidenceLine => ({
    roomTypeId: ROOM_TYPE,
    stayDate,
    recognizedOn: stayDate,
    grossRoomAmount,
    occupiedRoomNights: 1,
    economicEvent: "room_night",
    lifecycleState: "confirmed",
    evidenceQuality,
    linePosition: 1,
    ...overrides,
  });
  const command = (
    overrides: Partial<AppendExternalRevenueEvidenceCommand> = {},
  ): AppendExternalRevenueEvidenceCommand => ({
    propertyId: PROPERTY,
    guestBookingId: OTA_BOOKING,
    sourceKind: "ota",
    sourceBookingReference: OTA_REFERENCE,
    idempotencyKey: "external-revision-1",
    lines: [
      line("2026-09-01", "100", "exact"),
      line("2026-09-01", "50", "inferred", { linePosition: 2 }),
      line("2026-09-02", null, "missing"),
    ],
    ...overrides,
  });
  const append = (overrides: Partial<AppendExternalRevenueEvidenceCommand> = {}, db = client) =>
    appendExternalNightlyRevenueEvidence(db, command(overrides));
  beforeAll(async () => {
    if (!/test/i.test(new URL(DATABASE_URL!).pathname)) throw new Error("Refusing non-test DB");
    await client.connect();
    await client.query(
      "INSERT INTO hotel_catalog.properties (id,public_id,display_name) VALUES ($1,$1::uuid::text,'Revenue test'),($2,$2::uuid::text,'Other')",
      [PROPERTY, OTHER_PROPERTY],
    );
    await client.query(
      `INSERT INTO booking.guest_bookings
       (id,property_id,public_reference,source_system,source_booking_id,lifecycle_status,payment_status,
        check_in,check_out,room_count,currency,total_amount,balance_amount,booking_channel)
       VALUES ($1,$3,$1::uuid::text,'pms',$4,'confirmed','unpaid','2026-09-01','2026-12-01',2,'EUR',0,0,'airbnb'),
         ($2,$3,$2::uuid::text,'booking',NULL,'confirmed','unpaid','2026-09-01','2026-12-01',1,'EUR',0,0,'unknown')`,
      [OTA_BOOKING, DIRECT_BOOKING, PROPERTY, OTA_REFERENCE],
    );
    const roomScopes = [PROPERTY, ROOM_TYPE, OTHER_PROPERTY, OTHER_ROOM_TYPE];
    await client.query(
      "INSERT INTO booking.nightly_revenue_room_scopes (property_id,room_type_id) VALUES ($1,$2),($3,$4)",
      roomScopes,
    );
  });
  beforeEach(() => client.query("BEGIN"));
  afterEach(async () => {
    await client.query("ROLLBACK");
    for (const peer of peers.splice(0)) await peer.query("ROLLBACK").finally(() => peer.end());
  });
  afterAll(async () => {
    await client.query("SET session_replication_role=replica");
    const properties = [[PROPERTY, OTHER_PROPERTY]];
    await client.query(
      `WITH evidence AS (DELETE FROM booking.nightly_revenue_evidence WHERE property_id=ANY($1::uuid[])),
       rooms AS (DELETE FROM booking.nightly_revenue_room_scopes WHERE property_id=ANY($1::uuid[])),
       bookings AS (DELETE FROM booking.guest_bookings WHERE property_id=ANY($1::uuid[]))
       DELETE FROM hotel_catalog.properties WHERE id=ANY($1::uuid[])`,
      properties,
    );
    await client.query("SET session_replication_role=origin");
    await client.end();
  });

  it("preserves explicit quality, private scope, and strict replay", async () => {
    const first = await append();
    expect(await append()).toEqual({ ...first, outcome: "replayed" });
    await expect(append({ sourceKind: "manual" })).rejects.toMatchObject({
      code: "external_evidence_idempotency_conflict",
    });
    for (const overrides of [
      { propertyId: randomUUID() },
      { sourceBookingReference: "wrong" },
      { guestBookingId: DIRECT_BOOKING },
      { lines: [line("2026-09-01", "1", "exact", { roomTypeId: OTHER_ROOM_TYPE })] },
      { lines: [line("2026-09-01", "1", "exact", { linePosition: 3 })] },
    ])
      await expect(append({ ...overrides, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(
        ExternalRevenueEvidenceScopeError,
      );
    for (const lines of [
      [null],
      [line("2026-02-30", "1", "exact")],
      [{ ...line("2026-09-01", "1", "exact"), stayDate: 123 }],
      [{ ...line("2026-09-01", "1", "exact"), grossRoomAmount: 123 }],
    ])
      await expect(append({ lines } as never)).rejects.toThrow();
    const evidence = await client.query<{ ok: boolean }>(
      `SELECT string_agg(COALESCE(gross_room_amount::text,'null')||':'||evidence_quality,',' ORDER BY stay_date,gross_room_amount DESC NULLS LAST) =
       '100.0000:exact,50.0000:inferred,null:missing' AND bool_and(to_jsonb(evidence)::text NOT LIKE '%'||$2||'%') ok
       FROM booking.finance_nightly_revenue_evidence evidence WHERE guest_booking_id=$1`,
      [OTA_BOOKING, OTA_REFERENCE],
    );
    expect(evidence.rows[0]!.ok).toBe(true);
  });

  it("corrects removed-room revenue and commission atomically using original rules", async () => {
    await client.query(
      `INSERT INTO finance.commission_rules
        (property_id,rule_scope,product,commission_type,percentage_rate,starts_at,source_system,ota_channel,revision)
       VALUES ($1,'property','pms','percentage',15,'2026-01-01','finance','airbnb',1)`,
      [PROPERTY],
    );
    const timezone = {
      source: {
        ownerDomain: "hotel_catalog" as const,
        entityType: "property_profile" as const,
        entityId: PROPERTY,
        revision: "profile:1",
      },
      timeZone: "Europe/Berlin",
    };
    const baseCommand = command({
      lines: [line("2026-09-01", "100", "exact", { linePosition: 2 })],
    });
    const base = await appendExternalNightlyRevenueEconomics(client, baseCommand, timezone);
    await client.query("UPDATE booking.guest_bookings SET room_count=1 WHERE id=$1", [OTA_BOOKING]);
    expect(await appendExternalNightlyRevenueEconomics(client, baseCommand, timezone)).toEqual({
      ...base,
      outcome: "replayed",
    });
    await expect(
      append({ lines: [line("2026-09-01", "101", "exact", { linePosition: 2 })] }),
    ).rejects.toMatchObject({ code: "external_evidence_idempotency_conflict" });
    await client.query(
      "UPDATE finance.commission_rules SET percentage_rate=99 WHERE property_id=$1",
      [PROPERTY],
    );
    const correction = command({
      idempotencyKey: "remove-second-room",
      lines: [
        line("2026-09-01", "-100", "exact", {
          linePosition: 2,
          occupiedRoomNights: -1,
          economicEvent: "occupancy_adjustment",
          lifecycleState: "corrected",
          correctsEvidenceId: base.evidenceIds[0],
        }),
      ],
    });
    await client.query("SAVEPOINT failed_economics");
    await expect(
      appendExternalNightlyRevenueEconomics(client, correction, {
        ...timezone,
        source: { ...timezone.source, entityId: OTHER_PROPERTY },
      }),
    ).rejects.toMatchObject({ code: "ota_commission_evidence_scope_unavailable" });
    await client.query("ROLLBACK TO SAVEPOINT failed_economics");
    expect(
      (
        await client.query(
          `SELECT
      (SELECT count(*)::int FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1) AS revenue,
      (SELECT count(*)::int FROM finance.ota_commission_evidence WHERE guest_booking_id=$1) AS commission`,
          [OTA_BOOKING],
        )
      ).rows[0],
    ).toEqual({ revenue: 1, commission: 1 });
    const result = await appendExternalNightlyRevenueEconomics(client, correction, timezone);
    expect(await appendExternalNightlyRevenueEconomics(client, correction, timezone)).toEqual({
      ...result,
      outcome: "replayed",
    });
    const totals = await client.query(
      `SELECT sum(gross_room_amount)::text AS gross, sum(occupied_room_nights)::int AS nights
       FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1`,
      [OTA_BOOKING],
    );
    expect(totals.rows[0]).toEqual({ gross: "0.0000", nights: 0 });
    const commissions = await client.query(
      `SELECT percentage_rate::text AS rate, commission_amount::text AS amount,
        corrects_commission_evidence_id IS NOT NULL AS correction
       FROM finance.ota_commission_evidence WHERE guest_booking_id=$1 ORDER BY correction`,
      [OTA_BOOKING],
    );
    expect(commissions.rows).toEqual([
      { rate: "15.0000", amount: "15.0000", correction: false },
      { rate: "15.0000", amount: "-15.0000", correction: true },
    ]);
  });

  it("rejects unrelated correction targets and occupancy increases for removed positions", async () => {
    const base = await append({ lines: [line("2026-09-01", "100", "exact", { linePosition: 2 })] });
    const otherBooking = randomUUID();
    await client.query(
      `INSERT INTO booking.guest_bookings
        (id,property_id,public_reference,source_system,source_booking_id,lifecycle_status,payment_status,
         check_in,check_out,room_count,currency,total_amount,balance_amount)
       VALUES ($1,$2,$1::uuid::text,'pms',$1::uuid::text,'confirmed','unpaid','2026-09-01','2026-09-03',2,'EUR',100,100)`,
      [otherBooking, PROPERTY],
    );
    const unrelated = await append({
      guestBookingId: otherBooking,
      sourceBookingReference: otherBooking,
      idempotencyKey: randomUUID(),
      lines: [line("2026-09-01", "100", "exact", { linePosition: 2 })],
    });
    await client.query("INSERT INTO booking.nightly_revenue_room_scopes VALUES ($1,$2)", [
      PROPERTY,
      OTHER_ROOM_TYPE,
    ]);
    await client.query("UPDATE booking.guest_bookings SET room_count=1 WHERE id=$1", [OTA_BOOKING]);
    const correction = line("2026-09-01", "-100", "exact", {
      linePosition: 2,
      occupiedRoomNights: -1,
      economicEvent: "occupancy_adjustment",
      lifecycleState: "corrected",
      correctsEvidenceId: base.evidenceIds[0],
    });
    for (const override of [
      { correctsEvidenceId: null },
      { correctsEvidenceId: randomUUID() },
      { correctsEvidenceId: unrelated.evidenceIds[0] },
      { roomTypeId: OTHER_ROOM_TYPE },
      { stayDate: "2026-09-02" },
      { linePosition: 3 },
      { occupiedRoomNights: 1 as const, grossRoomAmount: "100" },
    ])
      await expect(
        append({ idempotencyKey: randomUUID(), lines: [{ ...correction, ...override }] }),
      ).rejects.toBeInstanceOf(ExternalRevenueEvidenceScopeError);
    await expect(
      append({ sourceKind: "manual", idempotencyKey: randomUUID(), lines: [correction] }),
    ).rejects.toBeInstanceOf(ExternalRevenueEvidenceScopeError);
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1",
          [OTA_BOOKING],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
  });

  it("permits money corrections for removed positions but rejects stale occupancy targets", async () => {
    const base = await append({ lines: [line("2026-09-01", "100", "exact", { linePosition: 2 })] });
    await client.query("UPDATE booking.guest_bookings SET room_count=1 WHERE id=$1", [OTA_BOOKING]);
    const correction = await append({
      idempotencyKey: "removed-room-price",
      lines: [
        line("2026-09-01", "10", "exact", {
          linePosition: 2,
          occupiedRoomNights: 0,
          economicEvent: "correction",
          lifecycleState: "corrected",
          correctsEvidenceId: base.evidenceIds[0],
        }),
      ],
    });
    const remove = (correctsEvidenceId: string) =>
      append({
        idempotencyKey: "removed-room-occupancy",
        lines: [
          line("2026-09-01", "-110", "exact", {
            linePosition: 2,
            occupiedRoomNights: -1,
            economicEvent: "occupancy_adjustment",
            lifecycleState: "corrected",
            correctsEvidenceId,
          }),
        ],
      });
    await client.query("SAVEPOINT stale_tip");
    await expect(remove(base.evidenceIds[0]!)).rejects.toMatchObject({
      constraint: "chk_booking_nightly_revenue_evidence_occupancy_transition",
    });
    await client.query("ROLLBACK TO SAVEPOINT stale_tip");
    await remove(correction.evidenceIds[0]!);
    expect(
      (
        await client.query(
          `SELECT sum(gross_room_amount)::text AS gross,
      sum(occupied_room_nights)::int AS nights FROM booking.nightly_revenue_evidence
      WHERE guest_booking_id=$1`,
          [OTA_BOOKING],
        )
      ).rows[0],
    ).toEqual({ gross: "0.0000", nights: 0 });
  });

  it("writes planned price and stay corrections through Booking and Finance", async () => {
    await client.query(
      "UPDATE booking.guest_bookings SET check_out='2026-09-02',room_count=1 WHERE id=$1",
      [OTA_BOOKING],
    );
    await client.query(
      `INSERT INTO finance.commission_rules
        (property_id,rule_scope,product,commission_type,percentage_rate,starts_at,source_system,ota_channel,revision)
       VALUES ($1,'property','pms','percentage',15,'2026-01-01','finance','airbnb',1)`,
      [PROPERTY],
    );
    const timezone = {
      source: {
        ownerDomain: "hotel_catalog" as const,
        entityType: "property_profile" as const,
        entityId: PROPERTY,
        revision: "profile:1",
      },
      timeZone: "Europe/Berlin",
    };
    const initial = await appendExternalNightlyRevenueEconomics(
      client,
      command({ lines: [line("2026-09-01", "100", "exact")] }),
      timezone,
    );
    const scope = {
      propertyId: PROPERTY,
      bookingId: OTA_BOOKING,
      sourceBookingReference: OTA_REFERENCE,
      currency: "EUR",
    };
    const current = (await loadBookingOtaRevenueLedger(client, scope))[0]!;
    expect(current.evidenceId).toBe(initial.evidenceIds[0]);
    const corrected = await appendExternalNightlyRevenueEconomics(
      client,
      command({
        idempotencyKey: "planned-price",
        lines: planOtaRevenueCorrections(
          [current],
          [{ ...current, grossRoomAmount: "80" }],
          "2026-09-10",
        ),
      }),
      timezone,
    );
    expect((await loadBookingOtaRevenueLedger(client, scope))[0]).toMatchObject({
      evidenceId: corrected.evidenceIds[0],
      grossRoomAmount: "80.0000",
    });
    const lines = planOtaRevenueCorrections(
      await loadBookingOtaRevenueLedger(client, scope),
      [{ ...current, stayDate: "2026-09-02", grossRoomAmount: "50" }],
      "2026-09-10",
    );
    const change = command({ idempotencyKey: "planned-stay", lines });
    await client.query(
      "UPDATE booking.guest_bookings SET check_in='2026-09-02',check_out='2026-09-03' WHERE id=$1",
      [OTA_BOOKING],
    );
    const applied = await appendExternalNightlyRevenueEconomics(client, change, timezone);
    expect(await appendExternalNightlyRevenueEconomics(client, change, timezone)).toEqual({
      ...applied,
      outcome: "replayed",
    });
    const ledger = await loadBookingOtaRevenueLedger(client, scope);
    expect(
      ledger.map(({ stayDate, grossRoomAmount, occupiedRoomNights }) => ({
        stayDate,
        grossRoomAmount,
        occupiedRoomNights,
      })),
    ).toEqual([
      { stayDate: "2026-09-01", grossRoomAmount: "0.0000", occupiedRoomNights: 0 },
      { stayDate: "2026-09-02", grossRoomAmount: "50.0000", occupiedRoomNights: 1 },
    ]);
    expect(
      (
        await client.query(
          `SELECT
      (SELECT sum(gross_room_amount)::text FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1) AS gross,
      (SELECT sum(occupied_room_nights)::int FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1) AS nights,
      (SELECT sum(commission_amount)::text FROM finance.ota_commission_evidence WHERE guest_booking_id=$1) AS commission`,
          [OTA_BOOKING],
        )
      ).rows[0],
    ).toEqual({ gross: "50.0000", nights: 1, commission: "7.5000" });
  });

  it("requires complete current-stay coverage and exact Booking scope", async () => {
    const scope = {
      propertyId: PROPERTY,
      bookingId: OTA_BOOKING,
      sourceBookingReference: OTA_REFERENCE,
      currency: "EUR",
    };
    await client.query("UPDATE booking.guest_bookings SET check_out='2026-09-02' WHERE id=$1", [
      OTA_BOOKING,
    ]);
    const read = (override = {}) => loadBookingOtaRevenueLedger(client, { ...scope, ...override });
    await expect(read()).rejects.toThrow("alteration_revenue_ledger_unavailable");
    await append({ lines: [line("2026-09-01", "100", "exact")] });
    await expect(read()).rejects.toThrow("alteration_revenue_ledger_unavailable");
    await append({
      idempotencyKey: "second-room",
      lines: [line("2026-09-01", null, "missing", { linePosition: 2 })],
    });
    expect(await read()).toHaveLength(2);
    for (const override of [
      { propertyId: OTHER_PROPERTY },
      { bookingId: DIRECT_BOOKING },
      { sourceBookingReference: "wrong" },
      { currency: "USD" },
    ])
      await expect(read(override)).rejects.toThrow("alteration_revenue_ledger_unavailable");
    await client.query("UPDATE booking.guest_bookings SET room_count=1 WHERE id=$1", [OTA_BOOKING]);
    await expect(read()).rejects.toThrow("alteration_revenue_ledger_unavailable");
  });

  it("rejects mixed-source revenue instead of silently ignoring it", async () => {
    await client.query("UPDATE booking.guest_bookings SET check_out='2026-09-02' WHERE id=$1", [
      OTA_BOOKING,
    ]);
    await append({ lines: [line("2026-09-01", "100", "exact")] });
    await append({
      sourceKind: "manual",
      idempotencyKey: "manual-second-room",
      lines: [line("2026-09-01", "50", "exact", { linePosition: 2 })],
    });
    await expect(
      loadBookingOtaRevenueLedger(client, {
        propertyId: PROPERTY,
        bookingId: OTA_BOOKING,
        sourceBookingReference: OTA_REFERENCE,
        currency: "EUR",
      }),
    ).rejects.toThrow("alteration_revenue_ledger_unavailable");
  });

  it("rejects reads outside a caller-owned transaction", async () => {
    const peer = new pg.Client({ connectionString: DATABASE_URL });
    peers.push(peer);
    await peer.connect();
    await expect(
      loadBookingOtaRevenueLedger(peer, {
        propertyId: PROPERTY,
        bookingId: OTA_BOOKING,
        sourceBookingReference: OTA_REFERENCE,
        currency: "EUR",
      }),
    ).rejects.toThrow("alteration_revenue_ledger_unavailable");
  });

  it("serializes manual revisions and appends adjustment history", async () => {
    const first = new pg.Client({ connectionString: DATABASE_URL });
    const second = new pg.Client({ connectionString: DATABASE_URL });
    peers.push(first, second);
    await Promise.all([first.connect(), second.connect()]);
    await Promise.all([first.query("BEGIN"), second.query("BEGIN")]);
    const secondPid = (await second.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    const manual = (db: pg.Client, idempotencyKey: string, lines: ExternalRevenueEvidenceLine[]) =>
      append({ sourceKind: "manual", idempotencyKey, lines }, db);
    const event = (
      amount: string,
      economicEvent: ExternalRevenueEvidenceLine["economicEvent"],
      lifecycleState: ExternalRevenueEvidenceLine["lifecycleState"],
      correctsEvidenceId?: string,
    ) =>
      line("2026-10-01", amount, "exact", {
        recognizedOn: "2026-10-06",
        occupiedRoomNights: economicEvent === "occupancy_adjustment" ? -1 : 0,
        economicEvent,
        lifecycleState,
        correctsEvidenceId,
      });
    const base = await manual(first, "manual-base", [line("2026-10-01", "80", "exact")]);
    const pending = manual(second, "manual-cancel", [
      event("-80", "occupancy_adjustment", "canceled", base.evidenceIds[0]),
    ]);
    const blocked = () =>
      client
        .query(
          "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND wait_event='transactionid'",
          [secondPid],
        )
        .then(({ rowCount }) => rowCount);
    await expect.poll(blocked).toBe(1);
    await first.query("COMMIT");
    expect((await pending).sourceRevision).toBe(2);
    await second.query("COMMIT");
    const retainedId = (
      await manual(client, "manual-retained", [event("20", "retained_charge", "canceled")])
    ).evidenceIds[0]!;
    await manual(client, "manual-adjust", [
      event("-20", "refund", "refunded", retainedId),
      event("5", "correction", "corrected", retainedId),
    ]);
    const events = await client.query<{ value: string }>(
      "SELECT string_agg(economic_event,',' ORDER BY source_revision,economic_event) value FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1",
      [OTA_BOOKING],
    );
    expect(events.rows[0]!.value).toBe(
      "room_night,occupancy_adjustment,retained_charge,correction,refund",
    );
  });
});
