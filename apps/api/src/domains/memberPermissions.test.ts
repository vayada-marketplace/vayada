import { readdirSync, readFileSync } from "node:fs";

import { staffAccessPermissionKeys } from "@vayada/backend-auth";
import { PMS_OPERATING_CALENDAR_AUTHORIZATION } from "@vayada/domain-pms";
import { describe, expect, it } from "vitest";

import { lockMemberPermissions } from "./memberPermissions.js";

// Locked checks that still read identity.role_permission_grants by role key alone (VAY-2335).
// They agree with the routes only while team-roles and overrides can't carry their key, i.e.
// while the key stays outside the staff catalog. Move a check to lockMemberPermissions
// (memberPermissions.ts) before its key joins the catalog.
const GRANT_ROW_CHECKS: Record<string, readonly string[]> = {
  "pms.operations.manage": [
    "pmsInventoryMaterializationAuthorization.ts",
    "pmsManageScope.ts",
    "pmsMandatoryChargeConfirmationCommandRepository.ts",
    "pmsOperatingCalendarImpact.ts",
    "pmsPhysicalRoomUnitReconcileRepository.ts",
    "pmsPricingCommandRepository.ts",
    "pmsRoomFactsCommandRepository.ts",
    "pmsRoomPublicationCommandRepository.ts",
  ],
  "pms.finance.manage": ["financePaymentReadinessCommandRepository.ts"],
  "hotel_catalog.setup.manage": ["hotelCatalogStep1Repository.ts"],
};
// Grant-row readers that resolve team-roles themselves, or serve accounts without team-roles.
const OTHER_GRANT_READERS = [
  "memberPermissions.ts",
  "pmsInboxRolePermissions.ts",
  "platformPropertyLifecycleCommandRepository.ts",
  "pricingPaymentRepublish.fixtures.ts",
];

const domains = new URL("./", import.meta.url);
const source = (file: string) => readFileSync(new URL(file, domains), "utf8");

describe("grant-row permission checks (VAY-2335)", () => {
  it("lists every domain file that reads role grant rows", () => {
    const readers = readdirSync(domains)
      .filter((file) => file.endsWith(".ts") && !/\.test\.ts$/.test(file))
      .filter((file) => source(file).includes("identity.role_permission_grants"))
      .sort();
    expect(readers).toEqual(
      [...Object.values(GRANT_ROW_CHECKS).flat(), ...OTHER_GRANT_READERS].sort(),
    );
  });

  it.each(Object.entries(GRANT_ROW_CHECKS))(
    "keeps %s, checked by grant rows alone, out of the staff catalog",
    (permission, files) => {
      expect(
        staffAccessPermissionKeys,
        `${permission} joined the staff catalog: move ${files.join(", ")} to lockMemberPermissions`,
      ).not.toContain(permission);
      for (const file of files) {
        const text = source(file);
        expect(
          text.includes(`"${permission}"`) ||
            text.includes(`'${permission}'`) ||
            (text.includes("PMS_OPERATING_CALENDAR_AUTHORIZATION.permission") &&
              PMS_OPERATING_CALENDAR_AUTHORIZATION.permission === permission),
          `${file} checks ${permission}`,
        ).toBe(true);
      }
    },
  );
});

describe("lockMemberPermissions (VAY-2335)", () => {
  const member = {
    organizationId: "11111111-1111-4111-8111-111111111111",
    actorUserId: "22222222-2222-4222-8222-222222222222",
  };
  const propertyId = "33333333-3333-4333-8333-333333333333";

  function client(membership: Record<string, unknown>, assigned = false) {
    const sql: string[] = [];
    return {
      sql,
      async query<Row>(text: string): Promise<{ rows: Row[] }> {
        sql.push(text);
        const rows = text.includes("FROM identity.organization_memberships")
          ? [
              {
                id: "44444444-4444-4444-8444-444444444444",
                roleKey: "hotel_manager",
                mode: "assigned",
                accessOrigin: "agency",
                permissionOverrides: null,
                roleDefinitionId: null,
                pms: true,
                booking: true,
                ...membership,
              },
            ]
          : text.includes("FROM identity.membership_property_assignments")
            ? assigned
              ? [{ property_id: propertyId }]
              : []
            : text.includes("FROM identity.role_permission_grants")
              ? [{ permission: "booking.settings.manage" }]
              : [];
        return { rows: rows as Row[] };
      },
    };
  }

  it("refuses memberships the route gives no permissions", async () => {
    for (const membership of [
      { accessOrigin: "external_owner" },
      { mode: "none" },
      { roleKey: "external_owner", mode: "all" },
    ])
      await expect(lockMemberPermissions(client(membership), member)).resolves.toBeNull();
  });

  it("checks property access only when asked", async () => {
    await expect(lockMemberPermissions(client({}), member)).resolves.toEqual([
      "booking.settings.manage",
    ]);
    await expect(lockMemberPermissions(client({}), member, { propertyId })).resolves.toBeNull();
    await expect(lockMemberPermissions(client({}, true), member, { propertyId })).resolves.toEqual([
      "booking.settings.manage",
    ]);
    await expect(
      lockMemberPermissions(client({ mode: "all" }), member, { propertyId }),
    ).resolves.toEqual(["booking.settings.manage"]);
  });

  it("locks what it reads unless read-only", async () => {
    const locking = client({}, true);
    await lockMemberPermissions(locking, member, { propertyId });
    expect(locking.sql.map((text) => /FOR (KEY )?SHARE$/.exec(text.trim())?.[0])).toEqual([
      "FOR SHARE",
      "FOR SHARE",
      "FOR KEY SHARE",
    ]);
    const reading = client({}, true);
    await lockMemberPermissions(reading, member, { propertyId, readOnly: true });
    expect(reading.sql.some((text) => /\bFOR (KEY )?(SHARE|UPDATE)\b/.test(text))).toBe(false);
  });
});
