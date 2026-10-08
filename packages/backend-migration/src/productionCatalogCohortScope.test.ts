import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { IdentityCohortScope } from "./productionIdentityCohortScope.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { planProductionCatalogContent } from "./productionCatalogContentPlan.js";
import { planProductionCatalogCore } from "./productionCatalogCorePlan.js";
import { planCatalogOwnership } from "./productionCatalogOwnership.js";
import { buildProductionCatalogPlan } from "./productionCatalogPlan.js";
import { stableCatalogId } from "./productionCatalogValues.js";
import { parseProductionMigrationCohort } from "./productionMigrationCohort.js";
import { bindProductionMigrationCohort } from "./productionMigrationCohortBinding.js";
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
    // Computed on fm/vay-1362-cohort-parity-gate: the COHORT_HOTEL_UNRESOLVED check adds no writes.
    expect(scoped.checksum).toBe(
      "d27bf72af7e80652e4b640df9d6bca75ce3e398275edd9640ac6e5f5f462c4e2",
    );
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
    for (const [scope, propertyId, unresolved] of [
      [pmsOnly, B, ["COHORT_HOTEL_UNRESOLVED"]],
      [marketplaceMissing, A, []],
    ] as const) {
      const { ownership } = plans(scope);
      expect(ownership.blockers.map((row) => [row.code, row.source])).toEqual([
        ...unresolved.map((code) => [code, "pms.hotels"]),
        ["COHORT_MEMBERSHIP_MISMATCH", "hotel_catalog.properties"],
      ]);
      expect(ownership.blockers.at(-1)!.sourceId).toBe(propertyId);
    }
  });

  it("makes a non-cohort property private without a custom domain or public media", () => {
    const { core, presentation } = plans(cohort);
    expect(core.blockers).toEqual([]);
    expect(core.properties.find((property) => property.id === B)).toMatchObject({
      publicId: `legacy-private-property-${B}`,
      profileStatus: "private",
      completenessReasons: expect.arrayContaining(["outside_migration_cohort"]),
    });
    expect(core.properties.find((property) => property.id === A)).toMatchObject({
      publicId: `legacy-property-${A}`,
      profileStatus: "complete",
    });
    // The legacy slug is kept so slug collisions still block and Booking events still resolve.
    expect(core.slugs.map((slug) => [slug.propertyId, slug.slug])).toEqual([
      [A, "alpha"],
      [B, "beta"],
      [A, "old-alpha"],
      [B, "old-beta"],
    ]);
    expect(presentation.blockers).toEqual([]);
    expect(presentation.domains.map((domain) => domain.hostname)).toEqual(["alpha.example.test"]);
    expect(presentation.media.map((media) => [media.propertyId, media.publicApproved])).toEqual([
      [A, true],
      [B, false],
    ]);
  });

  it("blocks a custom domain that is not disabled on a property outside the cohort", () => {
    for (const [verificationStatus, codes] of [
      ["verified", ["CATALOG_PRIVATE_DOMAIN_CONFLICT"]],
      ["pending", ["CATALOG_PRIVATE_DOMAIN_CONFLICT"]],
      ["disabled", []],
    ] as const) {
      const { presentation } = plans(cohort, {
        domains: [
          {
            id: "cccccccc-0000-4000-8000-00000000000c",
            propertyId: B,
            hostname: "beta.example.test",
            verificationStatus,
            canonicalWhenVerified: verificationStatus === "verified",
            verifiedAt: null,
            updatedAt: "2026-08-03T00:00:00Z",
          },
        ],
      });
      expect(presentation.blockers.map((blocker) => blocker.code)).toEqual(codes);
      expect(presentation.domains.map((domain) => domain.hostname)).toEqual(["alpha.example.test"]);
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

describe("unresolved cohort hotels (VAY-1362)", () => {
  const P = "55555555-5555-4555-8555-555555555555";
  const MA2 = "66666666-6666-4666-8666-666666666666";
  const UC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const hash = (id: string) => `sha256:${createHash("sha256").update(id).digest("hex")}`;
  const pmsHotel = (id: string, user: string) =>
    row("pms", "hotels", { id, user_id: user, name: "PMS", slug: "p", ...AT });
  const unresolved = (
    sourceRows: IdentitySourceRow[],
    scope: IdentityCohortScope | null,
    existing: Parameters<typeof planCatalogOwnership>[1] = [],
  ) =>
    planCatalogOwnership(sourceRows, existing, undefined, scope)
      .blockers.filter((blocker) => blocker.code === "COHORT_HOTEL_UNRESOLVED")
      .map((blocker) => [blocker.source, blocker.sourceId, blocker.message]);
  const withHotel = { ...cohort, pmsHotelIds: [A, P].sort() };
  const resolvesTo = (reason: string) => [
    ["pms.hotels", hash(P), `Cohort hotel resolves to a private property (${reason})`],
  ];

  it("passes a cohort whose hotels all resolve, and is absent without a cohort", () => {
    expect(unresolved(rows, cohort)).toEqual([]);
    expect(unresolved(rows, full)).toEqual([]);
    const orphan = [...rows, row("auth", "users", { id: UC, type: "hotel" }), pmsHotel(P, UC)];
    expect(unresolved(orphan, null)).toEqual([]);
    expect(planCatalogOwnership(orphan).blockers).toEqual([]);
  });

  it("blocks a cohort hotel without a canonical property, with hashed evidence only", () => {
    const orphan = [...rows, row("auth", "users", { id: UC, type: "hotel" }), pmsHotel(P, UC)];
    expect(unresolved(orphan, withHotel)).toEqual(resolvesTo("missing_canonical_property"));
    const invalid = rows.map((source) =>
      source.data["id"] === A && source.sourceDatabase === "booking"
        ? { ...source, data: { ...source.data, platform_status: "gone" } }
        : source,
    );
    expect(unresolved(invalid, cohort)).toContainEqual([
      "booking.booking_hotels",
      hash(A),
      "Cohort hotel resolves to 0 catalog properties, not exactly one",
    ]);
    expect(JSON.stringify(unresolved(orphan, withHotel))).not.toContain(P);
  });

  it("blocks duplicate canonical candidates for a cohort hotel", () => {
    const profile = row("marketplace", "hotel_profiles", {
      id: MA2,
      user_id: UA,
      name: "MA2",
      status: "verified",
      ...AT,
    });
    expect(unresolved([...rows, profile], { ...cohort, marketplaceHotelIds: [MA, MA2] })).toEqual(
      [hash(MA), hash(MA2)]
        .sort()
        .map((subject) => [
          "marketplace.hotel_profiles",
          subject,
          "Cohort hotel resolves to a private property (duplicate_marketplace_profile)",
        ]),
    );
    const twice = [...rows, rows.find((source) => source.data["id"] === A)!];
    expect(unresolved(twice, cohort)).toEqual([
      [
        "booking.booking_hotels",
        hash(A),
        "Cohort hotel resolves to 2 catalog properties, not exactly one",
      ],
    ]);
  });

  it("blocks a cohort hotel quarantined for an older reason", () => {
    const creatorOwned = [
      ...rows,
      row("auth", "users", { id: UC, type: "creator" }),
      pmsHotel(P, UC),
    ];
    expect(unresolved(creatorOwned, withHotel)).toEqual(resolvesTo("legacy_owner_quarantined"));
    const previous = {
      propertyId: stableCatalogId("private-property", `pms:hotels:${A}`),
      sourceSystem: "pms" as const,
      sourceTable: "hotels",
      sourceId: A,
      migrationDisposition: "private_quarantine" as const,
      migrationDispositionReason: "ambiguous_canonical_property" as const,
    };
    expect(unresolved(rows, cohort, [previous])).toEqual([
      [
        "pms.hotels",
        hash(A),
        "Cohort hotel resolves to a private property (ambiguous_canonical_property)",
      ],
    ]);
  });

  it("blocks cohort PMS and Marketplace rows attached to a property outside the cohort", () => {
    expect(unresolved(rows, { ...cohort, pmsHotelIds: [A, B] })).toEqual([
      [
        "pms.hotels",
        hash(B),
        "Cohort hotel resolves to a private property (outside_migration_cohort)",
      ],
    ]);
    expect(unresolved(rows, { ...cohort, marketplaceHotelIds: [MA, MB] })).toEqual([
      [
        "marketplace.hotel_profiles",
        hash(MB),
        "Cohort hotel resolves to a private property (outside_migration_cohort)",
      ],
    ]);
  });

  it("refuses to bind such a cohort before any database write", async () => {
    const approved = (input: Partial<IdentityCohortScope>) =>
      parseProductionMigrationCohort({
        sourceRunId: `vay1351-${"c0".repeat(12)}`,
        ...cohort,
        ...input,
        approvalProofSha256: "a".repeat(64),
      });
    const client = { query: vi.fn() };
    // A stale private link from an earlier run keeps cohort PMS hotel A private.
    const stale = {
      propertyId: stableCatalogId("private-property", `pms:hotels:${A}`),
      sourceSystem: "pms" as const,
      sourceTable: "hotels",
      sourceId: A,
      migrationDisposition: "private_quarantine" as const,
      migrationDispositionReason: "missing_canonical_property" as const,
    };
    const readers = (stored: unknown = null, links: (typeof stale)[] = []) => ({
      snapshot: async () => ({ rows, cohort: stored as null }),
      sourceLinks: async () => links,
    });
    const cases: Array<[Partial<IdentityCohortScope>, string, ReturnType<typeof readers>]> = [
      [{ pmsHotelIds: [A, B] }, "COHORT_HOTEL_UNRESOLVED", readers()],
      [{ marketplaceHotelIds: [] }, "COHORT_HOTEL_UNRESOLVED", readers()],
      [{}, "COHORT_HOTEL_UNRESOLVED", readers(null, [stale])],
      [{}, "COHORT_CONFLICT", readers(approved({ pmsHotelIds: [] }))],
      [{ bookingHotelIds: [P] }, "COHORT_HOTEL_NOT_IN_SOURCE", readers()],
    ];
    for (const [input, code, reader] of cases) {
      const error: unknown = await bindProductionMigrationCohort(
        client,
        approved(input),
        reader,
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code });
      for (const id of [A, B, MA, MB, P]) expect((error as Error).message).not.toContain(id);
    }
    expect(client.query).not.toHaveBeenCalled();
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
