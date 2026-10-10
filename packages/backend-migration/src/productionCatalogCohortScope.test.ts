import { describe, expect, it } from "vitest";

import type { IdentityCohortScope } from "./productionIdentityCohortScope.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { planProductionCatalogContent } from "./productionCatalogContentPlan.js";
import { planProductionCatalogCore } from "./productionCatalogCorePlan.js";
import { planCatalogOwnership } from "./productionCatalogOwnership.js";
import { buildProductionCatalogPlan } from "./productionCatalogPlan.js";
import {
  planProductionCatalogPresentation,
  type ExistingCatalogMediaObject,
} from "./productionCatalogPresentationPlan.js";
import type { ProductionCatalogTargetState } from "./productionCatalogTargetReader.js";

// VAY-1362: hotel A is in the cohort, hotel B is not. Each has a Booking anchor, a PMS hotel
// with the same ID and an owner-attached Marketplace profile.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const MA = "33333333-3333-4333-8333-333333333333";
const MB = "44444444-4444-4444-8444-444444444444";
const UA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AT = { created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-02T00:00:00Z" };
const row = (
  sourceDatabase: IdentitySourceRow["sourceDatabase"],
  sourceTable: string,
  data: Record<string, unknown>,
): IdentitySourceRow => ({ sourceDatabase, sourceTable, rowOrdinal: 1, data });
const booking = (id: string, user: string, slug: string) =>
  row("booking", "booking_hotels", {
    id,
    user_id: user,
    name: `Hotel ${slug}`,
    slug,
    platform_status: "live",
    country: "AT",
    timezone: "Europe/Vienna",
    supported_languages: ["en"],
    default_language: "en",
    previous_slugs: [`old-${slug}`],
    amenities: [],
    images: [],
    hero_image: `https://legacy.example.test/${slug}.jpg`,
    custom_domain: `${slug}.example.test`,
    ...AT,
  });
const rows: IdentitySourceRow[] = [
  row("auth", "users", { id: UA, type: "hotel", status: "verified" }),
  row("auth", "users", { id: UB, type: "hotel", status: "verified" }),
  booking(A, UA, "alpha"),
  booking(B, UB, "beta"),
  row("pms", "hotels", { id: A, user_id: UA, name: "PMS A", slug: "alpha", city: "Vienna", ...AT }),
  row("pms", "hotels", { id: B, user_id: UB, name: "PMS B", slug: "beta", city: "Graz", ...AT }),
  row("marketplace", "hotel_profiles", {
    id: MA,
    user_id: UA,
    name: "MA",
    status: "verified",
    ...AT,
  }),
  row("marketplace", "hotel_profiles", {
    id: MB,
    user_id: UB,
    name: "MB",
    status: "verified",
    ...AT,
  }),
];
const cohort: IdentityCohortScope = {
  bookingHotelIds: [A],
  pmsHotelIds: [A],
  marketplaceHotelIds: [MA],
};
const full: IdentityCohortScope = {
  bookingHotelIds: [A, B],
  pmsHotelIds: [A, B],
  marketplaceHotelIds: [MA, MB],
};
const heroImage = (propertyId: string): ExistingCatalogMediaObject => ({
  id:
    propertyId === A
      ? "aaaaaaaa-0000-4000-8000-00000000000a"
      : "bbbbbbbb-0000-4000-8000-00000000000b",
  propertyId,
  purpose: "property.hero_image",
  sourceSystem: "booking",
  sourceTable: "booking_hotels",
  sourceRowId: `${propertyId}:hero_image`,
  visibility: "public",
  lifecycleStatus: "active",
  publicApproved: true,
});

function plans(scope: IdentityCohortScope | null, existing = {}) {
  const ownership = planCatalogOwnership(rows, [], undefined, scope);
  const core = planProductionCatalogCore(rows, ownership);
  const content = planProductionCatalogContent(rows, ownership, core);
  const presentation = planProductionCatalogPresentation(rows, ownership, content, {
    mediaObjects: [heroImage(A), heroImage(B)],
    ...existing,
  });
  return { ownership, core, presentation };
}

describe("catalog cohort scope (VAY-1362)", () => {
  it("plans exactly as before without a cohort or with a cohort of every hotel", () => {
    const none = planCatalogOwnership(rows);
    expect(planCatalogOwnership(rows, [], undefined, null)).toEqual(none);
    expect(planCatalogOwnership(rows, [], undefined, full)).toEqual(none);
    expect(none.properties.map((group) => group.migrationDisposition)).toEqual([
      "canonical",
      "canonical",
    ]);
    const target = emptyTarget();
    const before = buildProductionCatalogPlan(rows, target);
    expect(before.blockers).toEqual([]);
    expect(before.counts.properties).toBe(2);
    // Computed on the pre-cohort catalog code (fm/vay-1362-cohort-identity) for this fixture.
    expect(before.checksum).toBe(
      "24c2103bf0c88c26f6978585647f2d59282db6119d3aaf1b574ea2a828ccec30",
    );
    expect(buildProductionCatalogPlan(rows, target, full).checksum).toBe(before.checksum);
    const scoped = buildProductionCatalogPlan(rows, target, cohort);
    expect(scoped.blockers).toEqual([]);
    expect(scoped.checksum).not.toBe(before.checksum);
  });

  it("keeps a non-cohort anchor's ID and attaches its PMS and Marketplace rows privately", () => {
    const { ownership } = plans(cohort);
    expect(ownership.blockers).toEqual([]);
    const [alpha, beta] = ownership.properties;
    expect(alpha).toMatchObject({ propertyId: A, migrationDisposition: "canonical" });
    expect(beta).toMatchObject({
      propertyId: B,
      migrationDisposition: "private_quarantine",
      migrationDispositionReason: "outside_migration_cohort",
    });
    expect(beta!.pms.map((source) => source.sourceId)).toEqual([B]);
    expect(beta!.marketplace.map((source) => source.sourceId)).toEqual([MB]);
    expect(
      ownership.sourceLinks.map((link) => [
        link.sourceId,
        link.propertyId,
        link.migrationDisposition,
        link.migrationDispositionReason,
      ]),
    ).toEqual([
      [A, A, "canonical", null],
      [B, B, "private_quarantine", "outside_migration_cohort"],
      [MA, A, "canonical", null],
      [MB, B, "private_quarantine", "outside_migration_cohort"],
      [A, A, "canonical", null],
      [B, B, "private_quarantine", "outside_migration_cohort"],
    ]);
    expect(ownership.quarantinedSources.map((source) => source.sourceId).sort()).toEqual(
      [B, B, MB].sort(),
    );
    // No cohort row is ever quarantined as outside the cohort.
    for (const link of ownership.sourceLinks)
      if (link.migrationDispositionReason === "outside_migration_cohort")
        expect([
          ...cohort.bookingHotelIds,
          ...cohort.pmsHotelIds,
          ...cohort.marketplaceHotelIds,
        ]).not.toContain(link.sourceId);
  });

  it("replans stably and fails closed on links from a run without the cohort", () => {
    const first = planCatalogOwnership(rows, [], undefined, cohort);
    expect(planCatalogOwnership(rows, first.sourceLinks, undefined, cohort)).toEqual(first);
    const previous = planCatalogOwnership(rows).sourceLinks;
    expect(
      planCatalogOwnership(rows, previous, undefined, cohort).blockers.map((row) => [
        row.code,
        row.sourceId,
      ]),
    ).toEqual([
      ["CATALOG_SOURCE_DISPOSITION_CONFLICT", B],
      ["CATALOG_SOURCE_DISPOSITION_CONFLICT", MB],
      ["CATALOG_SOURCE_DISPOSITION_CONFLICT", B],
    ]);
  });

  it("blocks a property whose members disagree on cohort membership", () => {
    const pmsOnly = { ...cohort, pmsHotelIds: [A, B] };
    const marketplaceMissing = { ...cohort, marketplaceHotelIds: [] };
    for (const [scope, propertyId] of [
      [pmsOnly, B],
      [marketplaceMissing, A],
    ] as const) {
      const { ownership } = plans(scope);
      expect(ownership.blockers).toEqual([
        expect.objectContaining({
          code: "COHORT_MEMBERSHIP_MISMATCH",
          source: "hotel_catalog.properties",
          sourceId: propertyId,
        }),
      ]);
    }
  });

  it("attaches an owner's rows only to anchors on the same side of the cohort", () => {
    // One owner with cohort anchor A, non-cohort anchor B and one profile per side.
    const mixed = rows.map((source) =>
      source.data["user_id"] === UB ? { ...source, data: { ...source.data, user_id: UA } } : source,
    );
    const ownership = planCatalogOwnership(mixed, [], undefined, cohort);
    expect(ownership.blockers).toEqual([]);
    expect(
      ownership.sourceLinks
        .filter((link) => link.sourceSystem === "marketplace")
        .map((link) => [link.sourceId, link.propertyId, link.migrationDisposition]),
    ).toEqual([
      [MA, A, "canonical"],
      [MB, B, "private_quarantine"],
    ]);
    // Without a cohort the same owner's profiles stay ambiguous, as before.
    expect(planCatalogOwnership(mixed).quarantinedSources.map((source) => source.reason)).toEqual([
      "ambiguous_canonical_property",
      "ambiguous_canonical_property",
    ]);
  });
});

function emptyTarget(): ProductionCatalogTargetState {
  return {
    properties: [],
    sourceLinks: [],
    // As the identity step writes them: non-cohort resources are archived.
    ownerLinks: (
      [
        ["booking", "booking_hotel", A, "owner"],
        ["pms", "pms_hotel", A, "operator"],
        ["marketplace", "hotel_profile", MA, "owner"],
        ["booking", "booking_hotel", B, "owner"],
        ["pms", "pms_hotel", B, "operator"],
        ["marketplace", "hotel_profile", MB, "owner"],
      ] as const
    ).map(([product, resourceType, resourceId, relationship]) => ({
      organizationId: resourceId === A || resourceId === MA ? UA : UB,
      product,
      resourceType,
      resourceId,
      relationship,
      status: resourceId === A || resourceId === MA ? "active" : "archived",
    })),
    slugs: [],
    domains: [],
    locations: [],
    profiles: [],
    amenities: [],
    contacts: [],
    policies: [],
    media: [],
    mediaObjects: [heroImage(A), heroImage(B)],
    ownerRevisions: [],
  };
}
