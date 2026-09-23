import { createHash, randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { replacementStayKey } from "@vayada/domain-booking";
import { parsePmsInventoryReservationBundle } from "@vayada/domain-pms";
import { pricingDraftFixture } from "./pricingBookingDraft.fixtures.js";
import { acceptanceFixture } from "./pricingAcceptanceHistory.fixtures.js";
import { writePricingAcceptance } from "./pricingAcceptanceWriter.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { reserveRevalidatedQuoteInventory } from "./currentQuoteInventory.js";
import { calculateReplacementFixedCharges } from "./replacementFixedCharges.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";
import { lockCurrentQuoteGuestDisclosure } from "./currentQuoteGuestDisclosure.js";
import { lockFinancePricingAcceptanceTerms } from "./financePricingAcceptanceTerms.js";
import { finishCurrentQuoteAcceptanceTime } from "./currentQuoteAcceptanceTime.js";
import { pricingRoomRevenueProjection } from "./pricingRoomRevenueProjection.js";
import { parseBookingQuoteAcceptanceInput } from "./bookingQuoteAcceptanceInput.js";

vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: vi.fn() }));
vi.mock("./currentQuoteInventory.js", () => ({ reserveRevalidatedQuoteInventory: vi.fn() }));
vi.mock("./currentQuoteRevalidation.js", () => ({ lockCurrentQuoteRevalidation: vi.fn() }));
vi.mock("./currentQuoteGuestDisclosure.js", () => ({ lockCurrentQuoteGuestDisclosure: vi.fn() }));
vi.mock("./financePricingAcceptanceTerms.js", () => ({
  lockFinancePricingAcceptanceTerms: vi.fn(),
}));
vi.mock("./currentQuoteAcceptanceTime.js", () => ({
  finishCurrentQuoteAcceptanceTime: vi.fn(),
}));

const url = process.env.TEST_DATABASE_URL;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe.skipIf(!url)("pricing acceptance writer transaction (PostgreSQL)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("keeps every staged effect invisible until commit and replays without new writes", async () => {
    const fixture = await setupFixture();
    const affiliateContextId = randomUUID();
    await fixture.observer.query(
      "INSERT INTO booking.affiliate_click_contexts(id,property_id,synthetic) VALUES($1,$2,TRUE)",
      [affiliateContextId, fixture.propertyId],
    );
    await fixture.observer.query(
      `INSERT INTO booking.affiliate_click_admissions
         (context_id,property_id,click_id,history_position) VALUES($1,$2,$3,1)`,
      [affiliateContextId, fixture.propertyId, randomUUID()],
    );
    const internal = { syntheticAffiliateContextId: affiliateContextId };
    let staged!: () => void, release!: () => void;
    const stagedPromise = new Promise<void>((resolve) => (staged = resolve));
    const releasePromise = new Promise<void>((resolve) => (release = resolve));
    mockOwners(fixture);
    vi.mocked(finishCurrentQuoteAcceptanceTime).mockImplementation(async (client) => {
      // Keep the shared worker suite from claiming this committed fixture before cleanup.
      await client.query(
        "UPDATE platform.jobs SET run_after=clock_timestamp()+interval '1 day' WHERE queue_name='pms-reservation-handoff' AND property_id=$1",
        [fixture.propertyId],
      );
      staged();
      await releasePromise;
      return new Date().toISOString();
    });

    const write = writePricingAcceptance(fixture.pool, fixture.input, internal);
    await stagedPromise;
    const replay = writePricingAcceptance(fixture.pool, fixture.input, internal);
    const secondPid = await waitForSecondWriter(fixture);
    await expect(isBlocked(fixture.observer, secondPid)).resolves.toBe(true);
    await expect(snapshot(fixture.observer, fixture)).resolves.toEqual({
      bookings: 0,
      acceptances: 0,
      jobs: 0,
      revenue: 0,
      available: 3,
      assigned: 0,
    });
    release();
    const accepted = await write;
    expect(accepted).toMatchObject({ kind: "accepted" });
    await expect(replay).resolves.toMatchObject({
      kind: "replayed",
      bookingId: accepted.bookingId,
    });
    const committed = await snapshot(fixture.observer, fixture);
    expect(committed).toEqual({
      bookings: 1,
      acceptances: 1,
      jobs: 2,
      revenue: 2,
      available: 2,
      assigned: 1,
    });
    expect(
      (
        await fixture.observer.query(
          "SELECT context_id,history_cutoff FROM booking.affiliate_original_booking_bindings WHERE booking_id=$1",
          [accepted.bookingId],
        )
      ).rows[0],
    ).toEqual({ context_id: affiliateContextId, history_cutoff: "1" });
    await fixture.observer.query(
      `INSERT INTO booking.affiliate_click_admissions
         (context_id,property_id,click_id,history_position) VALUES($1,$2,$3,2)`,
      [affiliateContextId, fixture.propertyId, randomUUID()],
    );

    await expect(
      writePricingAcceptance(fixture.pool, fixture.input, internal),
    ).resolves.toMatchObject({
      kind: "replayed",
      bookingId: accepted.bookingId,
    });
    expect(
      (
        await fixture.observer.query(
          "SELECT history_cutoff FROM booking.affiliate_original_booking_bindings WHERE booking_id=$1",
          [accepted.bookingId],
        )
      ).rows[0].history_cutoff,
    ).toBe("1");
    expect(await snapshot(fixture.observer, fixture)).toEqual(committed);
    await fixture.close();
  });

  it("rolls back booking, inventory, revenue, acceptance and jobs after the final gate", async () => {
    const fixture = await setupFixture();
    mockOwners(fixture);
    vi.mocked(finishCurrentQuoteAcceptanceTime).mockResolvedValue(fixture.f.finance.validUntil!);

    await expect(writePricingAcceptance(fixture.pool, fixture.input)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(snapshot(fixture.observer, fixture)).resolves.toEqual({
      bookings: 0,
      acceptances: 0,
      jobs: 0,
      revenue: 0,
      available: 3,
      assigned: 0,
    });
    await fixture.close();
  });

  it("binds a live click admitted while acceptance waits for the context lock", async () => {
    const fixture = await setupFixture();
    const contextId = randomUUID();
    await fixture.observer.query(
      "INSERT INTO booking.affiliate_click_contexts(id,property_id,synthetic) VALUES($1,$2,FALSE)",
      [contextId, fixture.propertyId],
    );
    await fixture.observer.query("BEGIN");
    await fixture.observer.query(
      "SELECT id FROM booking.affiliate_click_contexts WHERE id=$1 FOR UPDATE",
      [contextId],
    );
    await fixture.observer.query(
      `INSERT INTO booking.affiliate_click_admissions
         (context_id,property_id,click_id,history_position) VALUES($1,$2,$3,1)`,
      [contextId, fixture.propertyId, randomUUID()],
    );
    mockOwners(fixture);
    vi.mocked(finishCurrentQuoteAcceptanceTime).mockImplementation(async (client) => {
      await client.query(
        "UPDATE platform.jobs SET run_after=clock_timestamp()+interval '1 day' WHERE queue_name='pms-reservation-handoff' AND property_id=$1",
        [fixture.propertyId],
      );
      return new Date().toISOString();
    });
    const writing = writePricingAcceptance(fixture.pool, fixture.input, {
      affiliateContextId: contextId,
    });
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (fixture.writerPids[0]) {
        blocked = await isBlocked(fixture.observer, fixture.writerPids[0]);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await fixture.observer.query("COMMIT");
    const result = await writing;
    expect(blocked).toBe(true);
    expect(result).toMatchObject({ kind: "accepted" });
    expect(
      (
        await fixture.observer.query(
          "SELECT context_id,history_cutoff,synthetic FROM booking.affiliate_original_booking_bindings WHERE booking_id=$1",
          [result.bookingId],
        )
      ).rows[0],
    ).toEqual({ context_id: contextId, history_cutoff: "1", synthetic: false });
    await fixture.close();
  }, 20_000);

  it("does not create a booking binding from an empty live context", async () => {
    const fixture = await setupFixture();
    const contextId = randomUUID();
    await fixture.observer.query(
      "INSERT INTO booking.affiliate_click_contexts(id,property_id,synthetic) VALUES($1,$2,FALSE)",
      [contextId, fixture.propertyId],
    );
    mockOwners(fixture);
    await expect(
      writePricingAcceptance(fixture.pool, fixture.input, { affiliateContextId: contextId }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await snapshot(fixture.observer, fixture)).toMatchObject({
      bookings: 0,
      acceptances: 0,
    });
    await fixture.close();
  });
});

async function setupFixture() {
  if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
    throw new Error("test database required");
  const rawPool = new pg.Pool({ connectionString: url, max: 3 });
  const writerPids: number[] = [];
  const pool = {
    connect: async () => {
      const client = await rawPool.connect();
      writerPids.push((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      return client;
    },
  };
  const observer = await rawPool.connect();
  const propertyId = randomUUID(),
    organizationId = randomUUID(),
    roomTypeId = randomUUID();
  const now = new Date();
  let charges!: NonNullable<ReturnType<typeof calculateReplacementFixedCharges>> & {
    sourceRevision: string;
  };
  const f = pricingDraftFixture((quote) => {
    Object.assign(quote, { quoteId: randomUUID() });
    Object.assign(quote.stay, { propertyId });
    Object.assign(quote.stay.rooms[0], { roomTypeId });
    Object.assign(quote.evidence, {
      requestKey: replacementStayKey(quote.stay),
      issuedAt: new Date(now.getTime() - 60_000).toISOString(),
      expiresAt: new Date(now.getTime() + 600_000).toISOString(),
    });
    Object.assign(quote.evidence.terms[0], { roomTypeId });
    charges = {
      ...calculateReplacementFixedCharges(quote.stay, {
        version: "booking.fixed-charges.v1",
        currency: quote.stay.currency,
        charges: [],
      })!,
      sourceRevision: quote.evidence.revisions.charges,
    };
    Object.assign(quote.evidence, { mandatoryChargeEvidenceId: charges.basisEvidenceId });
  });
  Object.assign(f.current.scope, { propertyId, organizationId });
  Object.assign(f.finance.scope, { propertyId, organizationId });
  Object.assign(f.finance, {
    financeTermsCapturedAt: new Date(now.getTime() - 30_000).toISOString(),
    validUntil: new Date(now.getTime() + 600_000).toISOString(),
  });
  Object.assign(f.finance.commissionTermsSnapshot, {
    financeConfigUpdatedAt: new Date(now.getTime() - 60_000).toISOString(),
  });
  const quote = f.current.quote;
  Object.assign(f.current, {
    calculation: {
      addons: {
        kind: "addon_components",
        evaluatorVersion: "booking.addon-components.v2",
        sourceRevision: quote.evidence.revisions.addons,
        requestKey: replacementStayKey(quote.stay),
        currency: quote.stay.currency,
        totalMinor: "0",
        lines: [],
      },
      charges,
    },
  });
  await observer.query("BEGIN");
  await observer.query(
    "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Writer test',($1::uuid)::text)",
    [organizationId],
  );
  await observer.query(
    "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,($1::uuid)::text,'Writer test')",
    [propertyId],
  );
  await observer.query(
    `INSERT INTO pms.room_types(id,property_id,name,occupancy_limits,base_rate_amount,currency)
     VALUES($1,$2,'Writer room','{"adults":2,"children":1,"total":3}',100,'EUR')`,
    [roomTypeId, propertyId],
  );
  // This row is a transaction sentinel for the already-tested inventory owner.
  await observer.query("SET LOCAL session_replication_role=replica");
  await observer.query(
    `INSERT INTO pms.inventory_days
      (property_id,room_type_id,stay_date,total_count,available_count,assigned_count,
       calendar_revision,inventory_revision,generated_sellable_limit_count,effective_sellable_limit_count,
       generated_source_revision,channel_source_revision,manual_source_revision,block_source_revision,booking_source_revision)
     VALUES($1,$2,$3,3,3,0,1,1,3,3,1,0,0,0,0)`,
    [propertyId, roomTypeId, quote.stay.checkIn],
  );
  await observer.query("SET LOCAL session_replication_role=origin");
  await observer.query(
    `INSERT INTO booking.pricing_quotes(id,property_id,organization_id,request_id,request_hash,payload)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [
      quote.quoteId,
      propertyId,
      organizationId,
      f.command.requestId,
      hash(f.command.requestId),
      { quote, calculation: { version: "booking.quote-calculation.v1" } },
    ],
  );
  await observer.query("COMMIT");
  const { fingerprint: _fingerprint, ...command } = f.command;
  const input = {
    slug: "writer-test",
    command,
  };
  return {
    pool,
    observer,
    propertyId,
    organizationId,
    roomTypeId,
    writerPids,
    f,
    input,
    close: async () => {
      await observer.query("BEGIN");
      await observer.query("SET LOCAL session_replication_role=replica");
      await observer.query(
        `DELETE FROM platform.job_attempts WHERE job_id IN
          (SELECT id FROM platform.jobs WHERE property_id=$1)`,
        [propertyId],
      );
      const tables = (
        await observer.query(
          `SELECT c.table_schema,c.table_name FROM information_schema.columns c
           JOIN information_schema.tables table_info USING(table_schema,table_name)
           WHERE c.column_name='property_id' AND table_info.table_type='BASE TABLE'
             AND c.table_schema IN
             ('booking','distribution','finance','hotel_catalog','identity','marketplace','platform','pms')
           ORDER BY c.table_schema,c.table_name`,
        )
      ).rows as { table_schema: string; table_name: string }[];
      for (const { table_schema: schema, table_name: table } of tables) {
        if (!/^[a-z_]+$/.test(schema) || !/^[a-z_]+$/.test(table)) continue;
        await observer.query(`DELETE FROM "${schema}"."${table}" WHERE property_id::text=$1`, [
          propertyId,
        ]);
      }
      await observer.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
      await observer.query("DELETE FROM identity.organizations WHERE id=$1", [organizationId]);
      await observer.query("COMMIT");
      observer.release();
      await rawPool.end();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof setupFixture>>;

function mockOwners(fixture: Fixture) {
  const { f, propertyId, roomTypeId } = fixture;
  expect(
    parseBookingQuoteAcceptanceInput(fixture.input.command, f.current.quote, f.disclosure.policy),
  ).toEqual(f.command);
  expect(
    pricingRoomRevenueProjection(f.current.quote, f.current.calculation?.charges),
  ).not.toBeNull();
  vi.mocked(lockPublicPricingAuthority).mockImplementation(async (client) => {
    await lockPmsInventoryMutationScope(client, propertyId);
    return f.current.scope;
  });
  vi.mocked(lockCurrentQuoteRevalidation).mockResolvedValue(f.current);
  vi.mocked(lockCurrentQuoteGuestDisclosure).mockResolvedValue(f.disclosure);
  vi.mocked(lockFinancePricingAcceptanceTerms).mockResolvedValue(f.finance);
  vi.mocked(reserveRevalidatedQuoteInventory).mockImplementation(async (client) => {
    const changed = await client.query(
      `UPDATE pms.inventory_days SET available_count=available_count-1,assigned_count=assigned_count+1,
       inventory_revision=inventory_revision+1,booking_source_revision=booking_source_revision+1
       WHERE property_id=$1 AND room_type_id=$2 AND stay_date=$3 AND available_count>0 RETURNING 1`,
      [propertyId, roomTypeId, f.current.quote.stay.checkIn],
    );
    if (changed.rowCount !== 1) throw new Error("Quote inventory is unavailable");
    return {
      quote: f.current.quote,
      bundle: parsePmsInventoryReservationBundle(acceptanceFixture().inventory_reservation_bundle)!,
      replayed: false,
    };
  });
}

async function snapshot(client: PoolClient, fixture: Fixture) {
  const row = (
    await client.query(
      `SELECT
       (SELECT count(*)::int FROM booking.guest_bookings WHERE property_id=$1::uuid) AS bookings,
       (SELECT count(*)::int FROM booking.pricing_quote_acceptances WHERE property_id=$1::uuid) AS acceptances,
       (SELECT count(*)::int FROM platform.jobs WHERE property_id=$1::uuid) AS jobs,
       (SELECT count(*)::int FROM booking.nightly_revenue_evidence revenue
          JOIN booking.guest_bookings booking ON booking.id=revenue.guest_booking_id
         WHERE booking.property_id=$1::uuid) AS revenue,
       available_count::int AS available,assigned_count::int AS assigned
       FROM pms.inventory_days WHERE property_id=$2 AND room_type_id=$3 AND stay_date=$4`,
      [
        fixture.propertyId,
        fixture.propertyId,
        fixture.roomTypeId,
        fixture.f.current.quote.stay.checkIn,
      ],
    )
  ).rows[0];
  return row;
}

async function waitForSecondWriter(fixture: Fixture) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fixture.writerPids[1]) return fixture.writerPids[1];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("second writer did not connect");
}

async function isBlocked(client: PoolClient, pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const blocked = (
      await client.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [pid])
    ).rows[0].blocked;
    if (blocked) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}
