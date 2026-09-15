import { ingestBookingAffiliateCreation as ingestNative } from "./bookingAffiliateCreationIntake.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { readAffiliateEvidenceReview as readReview } from "./affiliateEvidenceReview.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ingestAffiliateEvidence as ingest,
  type ResolveAffiliateEvidenceAuthority,
} from "./affiliateEvidenceIntake.js";

const url = process.env["TEST_DATABASE_URL"];
const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);
const migration = await readFile(
  new URL("0193_booking_affiliate_evidence_intake.sql", migrations),
  "utf8",
);
const platform = await readFile(new URL("0010_platform_jobs_events_audit.sql", migrations), "utf8");
const id = (n: number) => `15050000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const binding = {
  organizationId: id(1),
  propertyId: id(2),
  connectionId: "connection-1",
  externalPropertyId: "external-1",
  state: "active" as const,
};
const authority = {
  binding,
  evidence: { ...binding, evidenceReference: "proof-1" },
  mappingVersion: "v1",
};
const sample = () => ({
  contractVersion: "affiliate-booking-evidence.v1",
  sourceEventKey: "event-1",
  sourceRevision: "1",
  supersedesEventKey: null,
  sourceOccurredAt: null,
  retrievedAt: null,
  booking: {
    externalPropertyId: "external-1",
    reservationId: "reservation-1",
    reservationItemId: null,
  },
  facts: { reservationStatus: "confirmed" },
  provenance: {
    kind: "authenticated_source_read",
    evidenceReference: "proof-1",
    originActor: "source_system",
    causedByVayadaCommandId: null,
  },
});

describe.skipIf(!url)("durable affiliate evidence intake (PostgreSQL)", () => {
  const name = `vay1505_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: url });
  let pool: pg.Pool;
  const resolve: ResolveAffiliateEvidenceAuthority = async (client) => {
    const row = (await client.query("SELECT active FROM scope_fixture FOR SHARE")).rows[0];
    return row.active ? authority : null;
  };
  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(url!).pathname.slice(1)))
      throw new Error("Requires test database");
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const isolated = new URL(url!);
    isolated.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: isolated.toString(), max: 6 });
  });
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS booking,platform,identity,hotel_catalog CASCADE;
      DROP TABLE IF EXISTS scope_fixture; CREATE TABLE scope_fixture(active boolean); INSERT INTO scope_fixture VALUES (true);
      CREATE SCHEMA booking; CREATE SCHEMA platform; CREATE SCHEMA identity; CREATE SCHEMA hotel_catalog;
      CREATE TABLE identity.organizations(id UUID PRIMARY KEY,kind TEXT DEFAULT 'hotel_group',status TEXT DEFAULT 'active');
      CREATE TABLE hotel_catalog.properties(id UUID PRIMARY KEY,profile_status TEXT DEFAULT 'incomplete');
      CREATE TABLE identity.organization_resource_links(organization_id UUID,resource_id TEXT,product TEXT,
        resource_type TEXT,status TEXT,relationship TEXT);`);
    await pool.query(
      platform.slice(
        platform.indexOf("CREATE FUNCTION platform.prevent_append_only_mutation()"),
        platform.indexOf("CREATE TABLE platform.domain_events ("),
      ),
    );
    await pool.query(migration);
    await pool.query("INSERT INTO identity.organizations VALUES ($1)", [id(1)]);
    await pool.query("INSERT INTO hotel_catalog.properties VALUES ($1)", [id(2)]);
    await pool.query(
      "INSERT INTO identity.organization_resource_links VALUES ($1,$2,'marketplace','hotel_profile','active','owner')",
      [id(1), id(2)],
    );
  });
  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });
  async function counts() {
    return (
      await pool.query(`SELECT (SELECT count(*)::int FROM booking.affiliate_evidence_observations) AS observations,
      (SELECT count(*)::int FROM booking.affiliate_evidence_deliveries) AS deliveries`)
    ).rows[0];
  }
  const nativeScope = { organizationId: id(1), propertyId: id(2), bookingId: id(3) };
  async function seedNative() {
    await pool.query(`CREATE TABLE booking.guest_bookings(id UUID PRIMARY KEY,property_id UUID,
      source_system TEXT DEFAULT 'booking',source_booking_id TEXT,booking_channel TEXT DEFAULT 'direct',
      direct_booking_source TEXT DEFAULT 'booking_engine',created_at TIMESTAMPTZ DEFAULT '2026-01-01Z',
      quote_session_id UUID,checkout_context_id UUID);
      CREATE TABLE booking.booking_status_events(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        guest_booking_id UUID REFERENCES booking.guest_bookings(id),event_type TEXT DEFAULT 'guest_booking.created',
        actor_type TEXT DEFAULT 'guest',occurred_at TIMESTAMPTZ DEFAULT '2026-01-01Z',
        event_payload JSONB DEFAULT '{"requestId":"native-request"}');`);
    await pool.query(
      "INSERT INTO booking.guest_bookings(id,property_id,quote_session_id,checkout_context_id) VALUES ($1,$2,$3,$4)",
      [id(3), id(2), id(4), id(5)],
    );
    await pool.query(
      "INSERT INTO booking.booking_status_events(id,guest_booking_id) VALUES ($1,$2)",
      [id(6), id(3)],
    );
  }
  it("stores native creation provenance once across concurrent calls and exposes it for review", async () => {
    await seedNative();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => ingestNative(pool, nativeScope)),
    );
    expect(results.filter((r) => r.outcome === "accepted")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "duplicate")).toHaveLength(3);
    const receipt = results[0]!;
    if (receipt.outcome === "rejected") throw new Error("native fixture failed");
    const review = await readReview(pool, id(2), id(1), receipt.observationId);
    expect(review.snapshot).toMatchObject({
      sourceEventKey: `native-creation:${id(6)}`,
      sourceOccurredAt: "2026-01-01T00:00:00.000Z",
      booking: { externalPropertyId: id(2), reservationId: id(3), reservationItemId: null },
      facts: {},
      provenance: { evidenceReference: `booking-status-event:${id(6)}`, originActor: "unknown" },
    });
    expect(review.connectionId).toBe(`vayada-booking:${id(2)}`);
    expect(review.reviewRequired).toBe(false);
    expect(await counts()).toEqual({ observations: 1, deliveries: 4 });
    await pool.query("UPDATE identity.organization_resource_links SET status='suspended'");
    expect(await ingestNative(pool, nativeScope)).toMatchObject({
      code: "unauthorized_connection",
    });
  });
  it.each([
    "UPDATE booking.guest_bookings SET source_system='pms'",
    "UPDATE booking.guest_bookings SET checkout_context_id=NULL",
    "UPDATE booking.guest_bookings SET quote_session_id=NULL",
    "DELETE FROM booking.booking_status_events",
    "UPDATE booking.booking_status_events SET actor_type='system'",
    "UPDATE booking.booking_status_events SET occurred_at='2026-01-02Z'",
    "UPDATE booking.booking_status_events SET event_payload='{}'",
    "INSERT INTO booking.booking_status_events(guest_booking_id) SELECT id FROM booking.guest_bookings",
    `UPDATE booking.guest_bookings SET property_id='${id(9)}'`,
  ])("rejects native evidence gaps without a receipt: %s", async (change) => {
    await seedNative();
    await pool.query(change);
    expect(await ingestNative(pool, nativeScope)).toMatchObject({
      code: "unauthorized_connection",
    });
    expect(await counts()).toEqual({ observations: 0, deliveries: 0 });
  });
  it.each([
    "UPDATE booking.guest_bookings SET source_system='pms'",
    "UPDATE booking.booking_status_events SET actor_type='system'",
    "INSERT INTO booking.booking_status_events(guest_booking_id) SELECT id FROM booking.guest_bookings",
  ])("locks native source through receipt commit: %s", async (change) => {
    await seedNative();
    const gate = await pool.connect(),
      writer = await pool.connect();
    let pending: ReturnType<typeof ingestNative> | undefined, update: Promise<unknown> | undefined;
    try {
      await gate.query("SELECT pg_advisory_lock(15050002)");
      await pool.query(`CREATE FUNCTION booking.pause_native() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(15050002); RETURN NEW; END; $$;
        CREATE TRIGGER pause_native BEFORE INSERT ON booking.affiliate_evidence_deliveries
        FOR EACH ROW EXECUTE FUNCTION booking.pause_native();`);
      pending = ingestNative(pool, nativeScope);
      await vi.waitFor(
        async () =>
          expect(
            (
              await pool.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'",
              )
            ).rowCount,
          ).toBe(1),
        { timeout: 3000 },
      );
      const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      update = writer.query(change);
      await waitForLock(pid);
      await gate.query("SELECT pg_advisory_unlock(15050002)");
      expect(await pending).toMatchObject({ outcome: "accepted" });
      await update;
      expect(await ingestNative(pool, nativeScope)).toMatchObject({
        code: "unauthorized_connection",
      });
      expect(await counts()).toEqual({ observations: 1, deliveries: 1 });
    } finally {
      await gate.query("SELECT pg_advisory_unlock_all()");
      await pending;
      await update;
      gate.release();
      writer.release();
    }
  });
  it.each([
    "UPDATE identity.organizations SET status='suspended'",
    "UPDATE identity.organizations SET kind='creator_workspace'",
    "UPDATE hotel_catalog.properties SET profile_status='disabled'",
    "DELETE FROM identity.organization_resource_links",
    "UPDATE identity.organization_resource_links SET status='suspended'",
    "UPDATE identity.organization_resource_links SET relationship='viewer'",
    "UPDATE identity.organization_resource_links SET product='pms'",
    "UPDATE identity.organization_resource_links SET resource_type='property'",
    `UPDATE identity.organization_resource_links SET resource_id='${id(9)}'`,
    `UPDATE identity.organization_resource_links SET organization_id='${id(9)}'`,
  ])("denies first intake and retries after scope changes: %s", async (change) => {
    await ingest(pool, sample(), resolve);
    await pool.query(change);
    for (const sourceEventKey of ["event-1", "new-event"]) {
      expect(await ingest(pool, { ...sample(), sourceEventKey }, resolve)).toEqual({
        outcome: "rejected",
        code: "unauthorized_connection",
      });
    }
    expect(await counts()).toEqual({ observations: 1, deliveries: 1 });
  });
  it("accepts operator ownership and rejects nonexistent or noncanonical scope", async () => {
    await pool.query("UPDATE identity.organization_resource_links SET relationship='operator'");
    const receipt = await ingest(pool, sample(), resolve);
    expect(receipt.outcome).toBe("accepted");
    if (receipt.outcome === "rejected") throw new Error("fixture failed");
    expect(await readReview(pool, id(2), id(1), receipt.observationId)).toMatchObject({
      observationId: receipt.observationId,
      reviewRequired: false,
    });
    for (const override of [
      { organizationId: id(9) },
      { propertyId: id(9) },
      { organizationId: "not-a-uuid" },
      { propertyId: "AAAAAAAA-0000-4000-8000-000000000001" },
    ]) {
      expect(
        await ingest(pool, sample(), async () => ({
          ...authority,
          binding: { ...binding, ...override },
          evidence: { ...authority.evidence, ...override },
        })),
      ).toMatchObject({ code: "unauthorized_connection" });
    }
    expect(await counts()).toEqual({ observations: 1, deliveries: 1 });
  });
  it("rejects uppercase aliases of an existing authorized scope", async () => {
    const canonical = {
      ...binding,
      organizationId: "aaaaaaaa-0000-4000-8000-000000000001",
      propertyId: "bbbbbbbb-0000-4000-8000-000000000002",
    };
    await pool.query("INSERT INTO identity.organizations(id) VALUES ($1)", [
      canonical.organizationId,
    ]);
    await pool.query("INSERT INTO hotel_catalog.properties(id) VALUES ($1)", [
      canonical.propertyId,
    ]);
    await pool.query(
      "INSERT INTO identity.organization_resource_links VALUES ($1,$2,'marketplace','hotel_profile','active','owner')",
      [canonical.organizationId, canonical.propertyId],
    );
    const source =
      (scope: typeof canonical): ResolveAffiliateEvidenceAuthority =>
      async () => ({
        ...authority,
        binding: scope,
        evidence: { ...authority.evidence, ...scope },
      });
    expect(await ingest(pool, sample(), source(canonical))).toMatchObject({ outcome: "accepted" });
    for (const key of ["organizationId", "propertyId"] as const) {
      const alias = { ...canonical, [key]: canonical[key].toUpperCase() };
      expect(await ingest(pool, sample(), source(alias))).toMatchObject({
        code: "unauthorized_connection",
      });
    }
    expect(await counts()).toEqual({ observations: 1, deliveries: 1 });
  });
  const revocations = [
    "UPDATE identity.organizations SET status='suspended'",
    "UPDATE hotel_catalog.properties SET profile_status='disabled'",
    "UPDATE identity.organization_resource_links SET status='suspended'",
  ];
  async function waitForLock(pid: number) {
    await vi.waitFor(
      async () => {
        const row = (
          await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])
        ).rows[0];
        expect(row?.wait_event_type).toBe("Lock");
      },
      { timeout: 3000, interval: 10 },
    );
  }
  it.each(revocations)("rechecks scope when revocation wins the race: %s", async (change) => {
    const revoker = await pool.connect();
    let pending: ReturnType<typeof ingest> | undefined;
    let pid = 0;
    try {
      await revoker.query("BEGIN");
      await revoker.query(change);
      pending = ingest(pool, sample(), async (client) => {
        pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        return authority;
      });
      await vi.waitFor(() => expect(pid).not.toBe(0));
      await waitForLock(pid);
      await revoker.query("COMMIT");
      expect(await pending).toMatchObject({ code: "unauthorized_connection" });
      expect(await counts()).toEqual({ observations: 0, deliveries: 0 });
    } finally {
      await revoker.query("ROLLBACK");
      await pending;
      revoker.release();
    }
  });
  it.each(revocations)("holds authorization until receipt commits: %s", async (change) => {
    const gate = await pool.connect(),
      revoker = await pool.connect();
    let pending: ReturnType<typeof ingest> | undefined;
    let update: Promise<unknown> | undefined;
    let pid = 0;
    try {
      await gate.query("SELECT pg_advisory_lock(15050001)");
      await pool.query(`CREATE FUNCTION booking.pause_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(15050001); RETURN NEW; END; $$;
        CREATE TRIGGER pause_delivery BEFORE INSERT ON booking.affiliate_evidence_deliveries
        FOR EACH ROW EXECUTE FUNCTION booking.pause_delivery();`);
      pending = ingest(pool, sample(), async (client) => {
        pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        return authority;
      });
      await vi.waitFor(() => expect(pid).not.toBe(0));
      await waitForLock(pid);
      const revokerPid = (await revoker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      update = revoker.query(change);
      await waitForLock(revokerPid);
      // No receipt is visible while the authorized transaction is paused.
      expect(await counts()).toEqual({ observations: 0, deliveries: 0 });
      await gate.query("SELECT pg_advisory_unlock(15050001)");
      expect(await pending).toMatchObject({ outcome: "accepted" });
      await update;
      expect(await ingest(pool, sample(), resolve)).toMatchObject({
        code: "unauthorized_connection",
      });
      expect(await counts()).toEqual({ observations: 1, deliveries: 1 });
    } finally {
      await gate.query("SELECT pg_advisory_unlock_all()");
      await pending;
      await update;
      gate.release();
      revoker.release();
    }
  });
  it("scopes paginated review, including conflicts outside the visible page", async () => {
    const receipt = await ingest(pool, sample(), resolve);
    if (receipt.outcome === "rejected") throw new Error("fixture failed");
    await ingest(pool, { ...sample(), facts: { reservationStatus: "cancelled" } }, resolve);
    // Deliberately equal microsecond timestamps exercise the UUID cursor tie-breaker.
    await pool.query(
      `INSERT INTO booking.affiliate_evidence_deliveries
      (id,observation_id,organization_id,property_id,fact_digest,mapping_version,snapshot,received_at)
      SELECT gen_random_uuid(),o.id,o.organization_id,o.property_id,o.fact_digest,o.mapping_version,
        o.snapshot,statement_timestamp() FROM booking.affiliate_evidence_observations o,
        generate_series(1,51) WHERE o.id=$1`,
      [receipt.observationId],
    );
    const first = await readReview(pool, id(2), id(1), receipt.observationId);
    expect(first.deliveries).toHaveLength(50);
    expect(first.reviewRequired).toBe(true);
    expect(first.deliveries.every((d: { factConflict: boolean }) => !d.factConflict)).toBe(true);
    const second = await readReview(pool, id(2), id(1), receipt.observationId, first.nextCursor);
    expect(second.deliveries).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.deliveries, ...second.deliveries].map((d) => d.id)).size).toBe(53);
    expect(await readReview(pool, id(3), id(1), receipt.observationId)).toBeNull();
    expect(await readReview(pool, id(2), id(3), receipt.observationId)).toBeNull();
    expect(await readReview(pool, id(2), id(1), receipt.observationId, id(9))).toBeNull();
    const other = await ingest(pool, { ...sample(), sourceEventKey: "other" }, resolve);
    if (other.outcome === "rejected") throw new Error("fixture failed");
    const otherPage = await readReview(pool, id(2), id(1), other.observationId);
    expect(
      await readReview(pool, id(2), id(1), receipt.observationId, otherPage.deliveries[0].id),
    ).toBeNull();
    await pool.query("UPDATE identity.organization_resource_links SET status='inactive'");
    expect(await readReview(pool, id(2), id(1), receipt.observationId)).toBeNull();
    await pool.query("UPDATE identity.organization_resource_links SET status='active'");
    await pool.query("UPDATE hotel_catalog.properties SET profile_status='disabled'");
    expect(await readReview(pool, id(2), id(1), receipt.observationId)).toBeNull();
  });
  it("serializes concurrent duplicates and keeps every delivery with one original receipt", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => ingest(pool, sample(), resolve)),
    );
    expect(results.filter((r) => r.outcome === "accepted")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "duplicate")).toHaveLength(11);
    const receipts = results.filter((r) => r.outcome !== "rejected");
    expect(new Set(receipts.map((r) => r.observationId)).size).toBe(1);
    expect(new Set(receipts.map((r) => r.receivedAt)).size).toBe(1);
    expect(await counts()).toEqual({ observations: 1, deliveries: 12 });
  });
  it("serializes conflicting first deliveries without overwriting the winning original", async () => {
    const changed = { ...sample(), facts: { reservationStatus: "cancelled" } };
    const results = await Promise.all([
      ingest(pool, sample(), resolve),
      ingest(pool, changed, resolve),
    ]);
    expect(results.filter((result) => result.outcome === "accepted")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "rejected")).toEqual([
      { outcome: "rejected", code: "event_key_conflict" },
    ]);
    expect(await counts()).toEqual({ observations: 1, deliveries: 2 });
    const original = (
      await pool.query("SELECT snapshot FROM booking.affiliate_evidence_observations")
    ).rows[0].snapshot;
    expect(await ingest(pool, original, resolve)).toMatchObject({
      outcome: "duplicate",
      processing: "review",
    });
  });
  it("retains conflicting facts, preserving the original and keeping later retries in review", async () => {
    await ingest(pool, sample(), resolve);
    expect(
      await ingest(pool, { ...sample(), facts: { reservationStatus: "cancelled" } }, resolve),
    ).toEqual({ outcome: "rejected", code: "event_key_conflict" });
    expect(await ingest(pool, sample(), resolve)).toMatchObject({
      outcome: "duplicate",
      processing: "review",
    });
    expect(await counts()).toEqual({ observations: 1, deliveries: 3 });
    expect(
      (
        await pool.query(
          "SELECT snapshot->'facts' AS facts FROM booking.affiliate_evidence_observations",
        )
      ).rows[0].facts,
    ).toEqual({ reservationStatus: "confirmed" });
  });
  it("records changed provenance even for identical facts and keeps the discrepancy visible", async () => {
    await ingest(pool, sample(), resolve);
    const next = sample();
    next.provenance.originActor = "hotel_operator";
    expect(await ingest(pool, next, resolve)).toMatchObject({
      outcome: "duplicate",
      processing: "review",
    });
    expect(await ingest(pool, sample(), resolve)).toMatchObject({ processing: "review" });
    expect(await counts()).toEqual({ observations: 1, deliveries: 3 });
  });
  it("retains new retrieval references without treating reference-only changes as conflicting facts", async () => {
    const first = await ingest(pool, sample(), resolve);
    const next = sample();
    next.provenance.evidenceReference = "proof-2";
    const result = await ingest(pool, next, async () => ({
      ...authority,
      evidence: { ...authority.evidence, evidenceReference: "proof-2" },
    }));
    expect(result).toEqual({ ...first, outcome: "duplicate" });
    expect(await counts()).toEqual({ observations: 1, deliveries: 2 });
  });
  it("rejects invalid and cross-property payloads and rechecks revocation on retries", async () => {
    expect(await ingest(pool, { ...sample(), propertyId: id(9) }, resolve)).toMatchObject({
      code: "invalid_contract",
    });
    expect(
      await ingest(pool, sample(), async () => ({
        ...authority,
        evidence: { ...authority.evidence, propertyId: id(9) },
      })),
    ).toMatchObject({ code: "unauthorized_connection" });
    expect(await counts()).toEqual({ observations: 0, deliveries: 0 });
    await ingest(pool, sample(), resolve);
    await pool.query("UPDATE scope_fixture SET active=false");
    expect(await ingest(pool, sample(), resolve)).toMatchObject({
      code: "unauthorized_connection",
    });
    expect(await counts()).toEqual({ observations: 1, deliveries: 1 });
  });
  it("rolls back the original receipt when delivery persistence fails", async () => {
    await pool.query(`CREATE FUNCTION booking.fail_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic delivery failure'; END; $$;
      CREATE TRIGGER fail_delivery BEFORE INSERT ON booking.affiliate_evidence_deliveries
      FOR EACH ROW EXECUTE FUNCTION booking.fail_delivery();`);
    await expect(ingest(pool, sample(), resolve)).rejects.toThrow("synthetic delivery failure");
    expect(await counts()).toEqual({ observations: 0, deliveries: 0 });
    await pool.query("DROP TRIGGER fail_delivery ON booking.affiliate_evidence_deliveries");
    expect(await ingest(pool, sample(), resolve)).toMatchObject({ outcome: "accepted" });
  });
  it("prevents mutation and deletion of either original evidence or delivery history", async () => {
    await ingest(pool, sample(), resolve);
    for (const table of ["affiliate_evidence_observations", "affiliate_evidence_deliveries"]) {
      await expect(pool.query(`UPDATE booking.${table} SET snapshot='{}'`)).rejects.toThrow(
        "append-only",
      );
      await expect(pool.query(`DELETE FROM booking.${table}`)).rejects.toThrow("append-only");
    }
    await expect(
      pool.query(
        "TRUNCATE booking.affiliate_evidence_observations,booking.affiliate_evidence_deliveries",
      ),
    ).rejects.toThrow("append-only");
  });
});
