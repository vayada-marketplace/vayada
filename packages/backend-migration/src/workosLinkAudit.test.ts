import { describe, expect, it } from "vitest";

import { findWorkosLinkAuditBlockers, type WorkosLinkAuditMetric } from "./workosLinkAudit.js";

describe("findWorkosLinkAuditBlockers", () => {
  it("returns no blockers when required WorkOS and resource link metrics are clean", () => {
    expect(findWorkosLinkAuditBlockers(cleanSummary())).toEqual([]);
  });

  it("returns the metrics that would block AuthKit rollout", () => {
    expect(
      findWorkosLinkAuditBlockers([
        ...cleanSummary(),
        { metric: "users_active_missing_workos_link", value: 2 },
        {
          metric: "hotel_group_orgs_with_active_members_missing_booking_hotel_link",
          value: 1,
        },
      ]),
    ).toEqual([
      "users_active_missing_workos_link",
      "hotel_group_orgs_with_active_members_missing_booking_hotel_link",
    ]);
  });

  it("blocks an empty migrated target database", () => {
    expect(
      findWorkosLinkAuditBlockers([
        { metric: "users_active_total", value: 0 },
        { metric: "organizations_active_total", value: 0 },
        { metric: "memberships_active_total", value: 0 },
        { metric: "resource_links_active_total", value: 0 },
      ]),
    ).toEqual([
      "users_active_total_zero",
      "organizations_active_total_zero",
      "memberships_active_total_zero",
      "resource_links_active_total_zero",
      "platform_orgs_with_workos_linked_active_members_total_zero",
    ]);
  });

  it("blocks when no WorkOS-linked platform organization can serve admin login", () => {
    expect(
      findWorkosLinkAuditBlockers([
        ...cleanSummary(),
        { metric: "platform_orgs_with_workos_linked_active_members_total", value: 0 },
      ]),
    ).toEqual(["platform_orgs_with_workos_linked_active_members_total_zero"]);
  });
});

function cleanSummary(): WorkosLinkAuditMetric[] {
  return [
    { metric: "users_active_total", value: 1 },
    { metric: "users_active_missing_workos_link", value: 0 },
    { metric: "organizations_active_total", value: 1 },
    { metric: "organizations_active_missing_workos_link", value: 0 },
    { metric: "memberships_active_total", value: 1 },
    { metric: "memberships_active_missing_workos_link", value: 0 },
    { metric: "resource_links_active_total", value: 1 },
    { metric: "platform_orgs_with_workos_linked_active_members_total", value: 1 },
    { metric: "hotel_group_orgs_with_active_members_missing_booking_hotel_link", value: 0 },
    { metric: "hotel_group_orgs_with_active_members_missing_pms_property_link", value: 0 },
    { metric: "affiliate_partner_orgs_with_active_members_missing_affiliate_link", value: 0 },
  ];
}
