import { describe, expect, it } from "vitest";

import {
  affiliateResourceIdForEmail,
  DEFAULT_NEXT_SMOKE_MODULE_IDS,
  NEXT_SMOKE_AFFILIATE_EMAIL,
  NEXT_SMOKE_AFFILIATE_RESOURCE_ID,
  NEXT_SMOKE_BOOKING_HOTEL_ID,
  NEXT_SMOKE_CONFIRM,
  nextSmokeApplyBlockers,
  nextSmokeConfigBlockers,
  normalizeModuleIds,
} from "./nextSmokeBackfill.js";

describe("next smoke backfill helpers", () => {
  it("pins the VAY-874/VAY-877 smoke defaults and apply guard", () => {
    expect(NEXT_SMOKE_CONFIRM).toBe("next-smoke-backfill:vay-874-vay-877");
    expect(NEXT_SMOKE_BOOKING_HOTEL_ID).toBe("43303cea-963c-445a-9522-a05145fe0918");
    expect(NEXT_SMOKE_AFFILIATE_EMAIL).toBe("flamur.maliqi2811@gmail.com");
    expect(NEXT_SMOKE_AFFILIATE_RESOURCE_ID).toBe("affiliate-smoke-flamur-maliqi2811");
    expect(DEFAULT_NEXT_SMOKE_MODULE_IDS).toEqual(["affiliates"]);
  });

  it("normalizes smoke affiliate resource IDs and module IDs", () => {
    expect(affiliateResourceIdForEmail(" Flamur.Maliqi2811+Smoke@Gmail.com ")).toBe(
      "affiliate-smoke-flamur-maliqi2811-smoke",
    );
    expect(normalizeModuleIds([])).toEqual(["affiliates"]);
    expect(normalizeModuleIds(["affiliates", "stripe", "affiliates"])).toEqual([
      "affiliates",
      "stripe",
    ]);
    expect(() => normalizeModuleIds(["bad module"])).toThrow(/Invalid module id/);
  });

  it("requires PMS and WorkOS readiness before apply can commit", () => {
    expect(
      nextSmokeApplyBlockers({
        mode: "apply",
        pmsConnectionString: undefined,
        hotelOrg: { workosOrgId: "org_hotel", activeMemberships: [{ userId: "user_1" }] },
        affiliateOrg: { workosOrgId: null, workosMembershipId: null },
      }),
    ).toEqual([
      "pms_database_url_required_for_feature_hub_modules",
      "affiliate_partner_missing_workos_org_id",
      "affiliate_partner_missing_workos_membership_id",
    ]);
  });

  it("does not require PMS module activation during dry runs", () => {
    expect(
      nextSmokeApplyBlockers({
        mode: "dry-run",
        pmsConnectionString: undefined,
        hotelOrg: { workosOrgId: "org_hotel", activeMemberships: [{ userId: "user_1" }] },
        affiliateOrg: {
          workosOrgId: "org_affiliate",
          workosMembershipId: "membership_affiliate",
        },
      }),
    ).toEqual([]);
  });

  it("blocks apply modes that would write unverified affiliate WorkOS state", () => {
    expect(
      nextSmokeConfigBlockers({
        mode: "apply",
        affiliateOrganizationId: undefined,
        affiliateWorkosOrgId: "org_manual",
        affiliateWorkosMembershipId: "om_manual",
      }),
    ).toEqual([
      "affiliate_organization_id_required_for_apply",
      "affiliate_workos_org_id_flag_is_dry_run_only",
      "affiliate_workos_membership_id_flag_is_dry_run_only",
    ]);

    expect(
      nextSmokeConfigBlockers({
        mode: "dry-run",
        affiliateOrganizationId: undefined,
        affiliateWorkosOrgId: "org_manual",
        affiliateWorkosMembershipId: "om_manual",
      }),
    ).toEqual([]);
  });
});
