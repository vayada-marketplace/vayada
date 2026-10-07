import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readAffiliatePerformance } from "./affiliatePerformanceReadModel.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
const id = (n: number) => `15120000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe.skipIf(!databaseUrl)("persisted affiliate performance reads", () => {
  const admin = new pg.Client({ connectionString: databaseUrl });
  const name = `vay1512_performance_test_${randomUUID().replaceAll("-", "")}`;
  let pool: pg.Pool;

  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(databaseUrl!).pathname.slice(1)))
      throw new Error("Requires isolated test database");
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString() });
  });
  afterAll(async () => {
    await pool?.end();
    if (pool) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS identity,hotel_catalog,marketplace,booking,finance CASCADE;
      CREATE SCHEMA identity; CREATE SCHEMA hotel_catalog; CREATE SCHEMA marketplace;
      CREATE SCHEMA booking; CREATE SCHEMA finance;
      CREATE TABLE identity.organization_resource_links(organization_id uuid,product text,resource_type text,resource_id text,relationship text,status text);
      CREATE TABLE hotel_catalog.properties(id uuid PRIMARY KEY,display_name text);
      CREATE TABLE marketplace.affiliate_agreements(id uuid PRIMARY KEY,property_id uuid,hotel_organization_id uuid,creator_profile_id uuid,creator_organization_id uuid);
      CREATE TABLE marketplace.affiliate_links(id uuid PRIMARY KEY,agreement_id uuid,property_id uuid);
      CREATE TABLE marketplace.affiliate_published_terms(id uuid PRIMARY KEY,disclosure jsonb);
      CREATE TABLE marketplace.affiliate_click_occurrences(id uuid PRIMARY KEY,link_id uuid,property_id uuid,terms_id uuid,source text,campaign_label text,synthetic boolean,clicked_at timestamptz);
      CREATE TABLE booking.guest_bookings(id uuid PRIMARY KEY,property_id uuid,created_at timestamptz);
      CREATE TABLE booking.affiliate_click_admissions(context_id uuid,click_id uuid,history_position bigint);
      CREATE TABLE booking.affiliate_original_booking_bindings(booking_id uuid,property_id uuid,context_id uuid,history_cutoff bigint,synthetic boolean);
      CREATE TABLE finance.affiliate_earning_journal(id uuid,property_id uuid,booking_id text,stay_item_id text,revision int,source_revision bigint,calculation_input jsonb,outcome jsonb,recorded_at timestamptz);
      CREATE TABLE finance.affiliate_earning_reconciliation_revisions(property_id uuid,booking_id uuid,stay_item_id uuid,revision int);
      INSERT INTO hotel_catalog.properties VALUES ('${id(1)}','Alpenrose'),('${id(2)}','Seeblick');
      INSERT INTO marketplace.affiliate_agreements VALUES
        ('${id(11)}','${id(1)}','${id(90)}','${id(80)}','${id(81)}'),
        ('${id(12)}','${id(2)}','${id(91)}','${id(80)}','${id(81)}');
      INSERT INTO identity.organization_resource_links VALUES
        ('${id(81)}','marketplace','creator_profile','${id(80)}','owner','active'),
        ('${id(90)}','marketplace','hotel_profile','${id(1)}','owner','active');
      INSERT INTO marketplace.affiliate_links VALUES
        ('${id(21)}','${id(11)}','${id(1)}'),('${id(22)}','${id(12)}','${id(2)}');
      INSERT INTO marketplace.affiliate_published_terms VALUES
        ('${id(31)}','{"terms":{"attributionWindowDays":30}}'),('${id(32)}','{"terms":{"attributionWindowDays":30}}');
      INSERT INTO marketplace.affiliate_click_occurrences VALUES
        ('${id(41)}','${id(21)}','${id(1)}','${id(31)}','unknown',NULL,FALSE,'2026-09-02'),
        ('${id(42)}','${id(21)}','${id(1)}','${id(31)}','instagram','launch',TRUE,'2026-09-03'),
        ('${id(43)}','${id(22)}','${id(2)}','${id(32)}','youtube','video-a',FALSE,'2026-09-04'),
        ('${id(44)}','${id(21)}','${id(1)}','${id(31)}','unknown','evergreen',FALSE,'2026-08-20');
      INSERT INTO booking.guest_bookings VALUES
        ('${id(51)}','${id(1)}','2026-09-05'),('${id(53)}','${id(1)}','2026-08-25');
      INSERT INTO booking.affiliate_click_admissions VALUES
        ('${id(61)}','${id(41)}',1),('${id(63)}','${id(44)}',1);
      INSERT INTO booking.affiliate_original_booking_bindings VALUES
        ('${id(51)}','${id(1)}','${id(61)}',1,FALSE),
        ('${id(53)}','${id(1)}','${id(63)}',1,FALSE);
      INSERT INTO finance.affiliate_earning_journal VALUES
        ('${id(71)}','${id(1)}','${id(51)}','${id(61)}',1,1,
          '{"scope":{"agreementId":"${id(11)}"}}',
          '{"status":"calculated","snapshot":{"commissionMinor":"5000","scope":{"currency":"EUR","currencyMinorUnit":2}},"adjustmentMinor":"5000"}','2026-09-06'),
        ('${id(72)}','${id(1)}','${id(51)}','${id(61)}',2,2,
          '{"scope":{"agreementId":"${id(11)}"}}','{"status":"pending","reason":"incomplete_evidence"}','2026-09-07'),
        ('${id(73)}','${id(2)}','${id(52)}','${id(62)}',1,1,
          '{"scope":{"agreementId":"${id(12)}"}}',
          '{"status":"calculated","snapshot":{"commissionMinor":"3000","scope":{"currency":"USD","currencyMinorUnit":2}},"adjustmentMinor":"3000"}','2026-09-08'),
        ('${id(74)}','${id(1)}','${id(53)}','${id(63)}',1,1,
          '{"scope":{"agreementId":"${id(11)}"}}',
          '{"status":"calculated","snapshot":{"commissionMinor":"200","scope":{"currency":"EUR","currencyMinorUnit":2}},"adjustmentMinor":"200"}','2026-09-09');
      INSERT INTO finance.affiliate_earning_reconciliation_revisions VALUES
        ('${id(1)}','${id(51)}','${id(61)}',2),('${id(2)}','${id(52)}','${id(62)}',1),
        ('${id(1)}','${id(53)}','${id(63)}',1);`);
  });

  it("serves creator hotels without synthetic clicks or mixed-currency totals", async () => {
    const result = await readAffiliatePerformance(pool, creatorContext(), query());
    expect(result.partnerships).toHaveLength(2);
    expect(result.partnerships[0]).toMatchObject({
      propertyName: "Alpenrose",
      clicks: 1,
      bookings: 1,
      stays: { total: 2, calculated: 1, pending: 1, needsReview: 0 },
      commissions: [{ currency: "EUR", calculatedMinor: "200", adjustmentMinor: "200" }],
      sources: [{ source: "unknown", clicks: 1 }],
      freshness: "current",
    });
    expect(result.partnerships[1]).toMatchObject({
      commissions: [{ currency: "USD", calculatedMinor: "3000", adjustmentMinor: "3000" }],
    });
    expect(result.period).toMatchObject({
      clickCohort: "clicked_at",
      bookingCohort: "booked_at",
      earningCohort: "latest_outcome_recorded_at",
    });
  });

  it("applies source filters, paginates with bound cursors and authorizes hotel scope", async () => {
    const filtered = await readAffiliatePerformance(
      pool,
      creatorContext(),
      query({ source: "unknown" }),
    );
    expect(filtered.partnerships[0]).toMatchObject({ clicks: 1, bookings: 1 });
    expect(filtered.partnerships[0]?.commissions).toEqual([
      { currency: "EUR", currencyMinorUnit: 2, calculatedMinor: "200", adjustmentMinor: "200" },
    ]);
    expect(filtered.partnerships[1]?.commissions).toEqual([]);
    const selected = await readAffiliatePerformance(
      pool,
      creatorContext(),
      query({ propertyId: id(1) }),
    );
    expect(selected.partnerships.map((item) => item.propertyId)).toEqual([id(1)]);
    expect(
      (await readAffiliatePerformance(pool, creatorContext(), query({ propertyId: id(99) })))
        .partnerships,
    ).toEqual([]);
    const first = await readAffiliatePerformance(pool, creatorContext(), query({ limit: 1 }));
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await readAffiliatePerformance(
      pool,
      creatorContext(),
      query({ limit: 1, cursor: first.nextCursor! }),
    );
    expect(second.partnerships[0]?.propertyId).toBe(id(2));
    await expect(
      readAffiliatePerformance(
        pool,
        creatorContext(),
        query({ cursor: first.nextCursor!, source: "unknown" }),
      ),
    ).rejects.toThrow("invalid affiliate performance cursor");
    const hotel = await readAffiliatePerformance(
      pool,
      hotelContext(),
      query({ propertyId: id(1) }),
    );
    expect(hotel.partnerships.map((item) => item.propertyId)).toEqual([id(1)]);
  });

  it("denies stale cross-tenant context and distinguishes available empty data from zero", async () => {
    const stale = creatorContext();
    stale.selectedOrganization.organizationId = id(99);
    await expect(readAffiliatePerformance(pool, stale, query())).rejects.toThrow(
      "scope unavailable",
    );
    await pool.query("DELETE FROM marketplace.affiliate_agreements");
    const empty = await readAffiliatePerformance(pool, creatorContext(), query());
    expect(empty).toMatchObject({ coverage: "available", partnerships: [], nextCursor: null });
  });
});

function query(overrides: Partial<Parameters<typeof readAffiliatePerformance>[2]> = {}) {
  return {
    from: "2026-09-01T00:00:00.000Z",
    to: "2026-10-01T00:00:00.000Z",
    limit: 25,
    ...overrides,
  };
}

function creatorContext(): RequestContext {
  return context("creator_workspace", id(81), id(80), "creator_profile");
}

function hotelContext(): RequestContext {
  const value = context("hotel_group", id(90), id(1), "hotel_profile");
  value.linkedResources.push({
    product: "hotel_catalog",
    resourceType: "property",
    resourceId: id(1),
    relationship: "owner",
    status: "active",
  });
  value.entitlements = [
    {
      product: "marketplace",
      key: "marketplace-hotel-profile",
      status: "active",
      resource: { product: "marketplace", resourceType: "hotel_profile", resourceId: id(1) },
    },
  ];
  value.membership.propertyAccess = {
    mode: "assigned",
    roleKey: "owner",
    accessOrigin: "agency",
    assignedPropertyIds: [id(1)],
  };
  return value;
}

function context(
  kind: "creator_workspace" | "hotel_group",
  organizationId: string,
  resourceId: string,
  resourceType: "creator_profile" | "hotel_profile",
): RequestContext {
  return {
    actor: {
      internalUserId: id(100),
      status: "active",
      email: "fixture@example.test",
      providerIdentity: { provider: "workos", providerUserId: "fixture" },
    },
    selectedOrganization: { organizationId, kind, status: "active" },
    membership: {
      membershipId: id(101),
      status: "active",
      roleKey: "owner",
      workosRoleSlugs: [],
      permissions: ["marketplace.collaboration.read"],
    },
    linkedResources: [
      { product: "marketplace", resourceType, resourceId, relationship: "owner", status: "active" },
    ],
    entitlements: [],
    locale: "en",
    currency: "EUR",
    audit: { requestId: "vay1512-test", source: "api", receivedAt: "2026-09-10T00:00:00.000Z" },
  };
}
