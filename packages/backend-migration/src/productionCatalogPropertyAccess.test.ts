import { describe, expect, it } from "vitest";

import type {
  CatalogOwnerLink,
  CatalogPropertyGroup,
  CatalogPropertySource,
} from "./productionCatalogOwnership.js";
import { planCatalogPropertyAccess } from "./productionCatalogPropertyAccess.js";

const P = "13620700-0000-4000-8000-000000000001";
const PRIVATE = "13620700-0000-4000-8000-000000000002";
const ORG = "13620700-0000-4000-8000-0000000000aa";
const OTHER = "13620700-0000-4000-8000-0000000000bb";
const group = (propertyId: string, canonical = true) =>
  ({
    propertyId,
    booking: { sourceId: propertyId } as CatalogPropertySource,
    pms: [{ sourceId: propertyId } as CatalogPropertySource],
    marketplace: [],
    migrationDisposition: canonical ? "canonical" : "private_quarantine",
  }) as unknown as CatalogPropertyGroup;
const link = (organizationId: string, type: string, resourceId: string, relationship: string) => {
  const [product, resourceType] = type.split(":");
  return { organizationId, product, resourceType, resourceId, relationship, status: "active" };
};
// As identity writes them: the Booking owner and the PMS operator link of one legacy hotel.
const owner = (resourceId: string, organizationId = ORG) =>
  [
    link(organizationId, "booking:booking_hotel", resourceId, "owner"),
    link(organizationId, "pms:pms_hotel", resourceId, "operator"),
  ] as CatalogOwnerLink[];
const target = { activeOrganizationIds: [ORG, OTHER], links: [], entitlements: [] };
const stored = (resourceId: string | null, status = "active", effective = true) => ({
  organizationId: ORG,
  entitlementKey: "property-management",
  resourceId,
  status,
  effective,
});
const native = (organizationId: string, relationship: string) =>
  ["hotel_catalog:property", "pms:pms_property"].map((type) =>
    link(organizationId, type, P, relationship),
  );

describe("cohort property access (VAY-1362)", () => {
  it("mirrors native setup for a cohort property and plans nothing for a private one", () => {
    const plan = planCatalogPropertyAccess(
      [group(P), group(PRIVATE, false)],
      [...owner(P), ...owner(PRIVATE)],
      target,
    );

    expect(plan.blockers).toEqual([]);
    expect(plan.links).toEqual(native(ORG, "owner"));
    expect(plan.entitlements).toEqual([
      {
        organizationId: ORG,
        product: "pms",
        entitlementKey: "property-management",
        status: "active",
        resourceProduct: "pms",
        resourceType: "pms_property",
        resourceId: P,
        metadata: { source: "legacy_migration_cohort" },
      },
    ]);
    expect(plan.pending).toEqual({ links: plan.links, entitlements: plan.entitlements });
  });

  it("plans no write for stored rows", () => {
    const first = planCatalogPropertyAccess([group(P)], owner(P), target);
    const replanned = planCatalogPropertyAccess([group(P)], owner(P), {
      ...target,
      links: first.links,
      entitlements: [stored(P)],
    });

    expect(replanned.links).toEqual(first.links);
    expect(replanned.pending).toEqual({ links: [], entitlements: [] });
  });

  it("takes operator when the active legacy links hold no owner relationship", () => {
    const links = owner(P);
    links[0]!.status = "archived";

    expect(planCatalogPropertyAccess([group(P)], links, target).links).toEqual(
      native(ORG, "operator"),
    );
  });

  it.each([
    ["an inactive organization", owner(P), [OTHER], 0],
    ["two organizations", [owner(P)[0]!, owner(P, OTHER)[1]!], [ORG, OTHER], 2],
  ])("blocks a cohort property with %s", (_case, links, activeOrganizationIds, count) => {
    const plan = planCatalogPropertyAccess([group(P)], links, { ...target, activeOrganizationIds });

    expect(plan.links).toEqual([]);
    expect(plan.blockers).toEqual([
      expect.objectContaining({
        code: "COHORT_PROPERTY_OWNER_UNRESOLVED",
        sourceId: P,
        message: `Cohort property resolves to ${count} active hotel organizations, not one`,
      }),
    ]);
  });

  it.each([
    [
      "a desired link stored suspended",
      native(ORG, "owner").map((row) => ({ ...row, status: "suspended" })),
      [],
    ],
    ["another organization's active link", native(OTHER, "owner").slice(1), []],
    ["an active operator link beside the owner link", native(ORG, "operator").slice(0, 1), []],
    ["a suspended organization-wide PMS grant", [], [stored(null, "suspended")]],
    ["its entitlement stored expired", [], [stored(P, "active", false)]],
  ])("blocks a cohort property with %s", (_case, links, entitlements) => {
    const plan = planCatalogPropertyAccess([group(P)], owner(P), {
      ...target,
      links,
      entitlements,
    });

    expect(plan.pending).toEqual({ links: [], entitlements: [] });
    expect(plan.blockers.map((row) => row.code)).toEqual(["COHORT_PROPERTY_ACCESS_CONFLICT"]);
  });

  it("ignores an organization-wide suspension that has ended", () => {
    const plan = planCatalogPropertyAccess([group(P)], owner(P), {
      ...target,
      entitlements: [stored(null, "suspended", false)],
    });

    expect(plan.blockers).toEqual([]);
  });
});
