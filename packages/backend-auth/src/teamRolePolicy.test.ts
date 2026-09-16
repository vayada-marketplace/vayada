import { describe, expect, it } from "vitest";
import {
  resolveTeamRolePermissions,
  validateTeamRoleDefaults,
  type TeamRolePolicy,
} from "./teamRolePolicy.js";

const staff: TeamRolePolicy = {
  securityClass: "staff",
  baseRoleKey: "hotel_custom",
  presetKey: null,
  defaultPermissions: ["pms.calendar.read"],
};

describe("organization role security policy", () => {
  it("allows a member's View-to-Edit override within the class ceiling", () => {
    expect(resolveTeamRolePermissions(staff, { grant: ["pms.calendar.manage"], deny: [] })).toEqual(
      ["pms.calendar.manage", "pms.calendar.read"],
    );
    expect(
      resolveTeamRolePermissions(
        { ...staff, defaultPermissions: ["pms.calendar.read", "pms.calendar.manage"] },
        { grant: [], deny: ["pms.calendar.manage"] },
      ),
    ).toEqual(["pms.calendar.read"]);
  });

  it.each([
    "identity.staff.manage",
    "finance.billing.manage",
    "identity.organization.manage",
    "unknown.permission",
  ])("rejects custom defaults and overrides granting %s", (key) => {
    expect(validateTeamRoleDefaults({ ...staff, defaultPermissions: [key] })).toBe(false);
    expect(resolveTeamRolePermissions(staff, { grant: [key], deny: [] })).toBeNull();
  });

  it("keeps manager authority tied to the manager preset", () => {
    const manager: TeamRolePolicy = {
      ...staff,
      baseRoleKey: "hotel_manager",
      presetKey: "agency_manager",
      defaultPermissions: ["identity.staff.manage"],
    };
    expect(resolveTeamRolePermissions(manager, null)).toEqual(["identity.staff.manage"]);
    expect(resolveTeamRolePermissions({ ...manager, presetKey: null }, null)).toBeNull();
    expect(
      resolveTeamRolePermissions({ ...manager, baseRoleKey: "hotel_custom" }, null),
    ).toBeNull();
  });

  it("keeps guest contact inaccessible for Housekeeping and its custom clones", () => {
    for (const presetKey of ["housekeeping", null]) {
      const role: TeamRolePolicy = {
        ...staff,
        securityClass: "housekeeping",
        baseRoleKey: "housekeeping",
        presetKey,
      };
      expect(resolveTeamRolePermissions(role, null)).toEqual(["pms.calendar.read"]);
      expect(
        resolveTeamRolePermissions(role, { grant: ["pms.guest_contact.read"], deny: [] }),
      ).toBeNull();
      expect(
        validateTeamRoleDefaults({ ...role, defaultPermissions: ["pms.guest_contact.read"] }),
      ).toBe(false);
    }
  });

  it("allows external-owner operations but rejects agency administration", () => {
    const owner: TeamRolePolicy = {
      ...staff,
      securityClass: "external_owner",
      baseRoleKey: "external_owner",
      presetKey: "property_owner",
    };
    expect(resolveTeamRolePermissions(owner, { grant: ["pms.calendar.manage"], deny: [] })).toEqual(
      ["pms.calendar.manage", "pms.calendar.read"],
    );
    for (const key of [
      "pms.settings.manage",
      "booking.settings.manage",
      "identity.staff.manage",
      "finance.billing.manage",
    ]) {
      expect(resolveTeamRolePermissions(owner, { grant: [key], deny: [] })).toBeNull();
    }
  });

  it("rejects role edits and member overrides that leave Edit without View", () => {
    expect(
      validateTeamRoleDefaults({ ...staff, defaultPermissions: ["pms.calendar.manage"] }),
    ).toBe(false);
    expect(
      resolveTeamRolePermissions(staff, {
        grant: ["pms.calendar.manage"],
        deny: ["pms.calendar.read"],
      }),
    ).toBeNull();
    expect(
      resolveTeamRolePermissions(
        { ...staff, defaultPermissions: [] },
        { grant: ["pms.calendar.manage"], deny: [] },
      ),
    ).toBeNull();
  });

  it.each([
    { grant: ["pms.calendar.read", "pms.calendar.read"], deny: [] },
    { grant: [], deny: ["pms.calendar.read", "pms.calendar.read"] },
    { grant: ["pms.calendar.read"], deny: ["pms.calendar.read"] },
    { grant: [], deny: ["unknown.permission"] },
    { grant: [], deny: [], unexpected: true },
    { grant: "pms.calendar.read", deny: [] },
    [],
    undefined,
  ])("fails closed on invalid stored overrides: %j", (overrides) => {
    expect(resolveTeamRolePermissions(staff, overrides)).toBeNull();
  });

  it("fails closed on malformed or inconsistent role definitions", () => {
    for (const patch of [
      { securityClass: "__proto__" },
      { securityClass: "constructor" },
      { baseRoleKey: "hotel_owner" },
      { presetKey: "constructor" },
      { presetKey: "front_desk" },
      { defaultPermissions: null },
      { defaultPermissions: ["pms.calendar.read", "pms.calendar.read"] },
    ])
      expect(resolveTeamRolePermissions({ ...staff, ...patch } as TeamRolePolicy, null)).toBeNull();
  });

  it("uses live Account-admin grants only for the immutable admin definition", () => {
    const admin: TeamRolePolicy = {
      securityClass: "account_admin",
      baseRoleKey: "hotel_owner",
      presetKey: "account_admin",
      defaultPermissions: [],
    };
    expect(resolveTeamRolePermissions(admin, null, ["finance.billing.manage"])).toEqual([
      "finance.billing.manage",
    ]);
    expect(
      resolveTeamRolePermissions(admin, { grant: [], deny: ["finance.billing.manage"] }, [
        "finance.billing.manage",
      ]),
    ).toBeNull();
    expect(resolveTeamRolePermissions({ ...admin, presetKey: null }, null)).toBeNull();
    expect(
      resolveTeamRolePermissions(
        { ...admin, defaultPermissions: ["finance.billing.manage"] },
        null,
      ),
    ).toBeNull();
  });
});
