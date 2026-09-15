import { describe, expect, it } from "vitest";
import type { QueryResultRow } from "pg";
import { lockPmsInboxRolePermissions } from "./pmsInboxRolePermissions.js";

describe("locked Inbox role permissions", () => {
  const definition = {
    security_class: "staff",
    base_role_key: "front_desk",
    preset_key: null,
    default_permissions: ["pms.inbox.read"],
  };
  const actor = { roleKey: "front_desk", roleDefinitionId: "role", permissionOverrides: null };
  function client(row: unknown = definition) {
    return {
      async query<T extends QueryResultRow>(sql: string, values?: readonly unknown[]) {
        if (sql.includes("identity.organization_roles")) {
          expect(sql).toContain("FOR SHARE");
          expect(values).toEqual(["role", "organization"]);
          return { rows: (row ? [row] : []) as T[] };
        }
        return {
          rows: [
            { permissionKey: "pms.inbox.read" },
            { permissionKey: "pms.inbox.reply" },
            { permissionKey: "finance.billing.manage" },
          ] as unknown as T[],
        };
      },
    };
  }
  it("uses the role definition rather than legacy grants, while allowing an explicit Edit override", async () => {
    await expect(lockPmsInboxRolePermissions(client(), "organization", actor)).resolves.toEqual(
      new Set(["pms.inbox.read"]),
    );
    await expect(
      lockPmsInboxRolePermissions(client(), "organization", {
        ...actor,
        permissionOverrides: { grant: ["pms.inbox.reply"], deny: [] },
      }),
    ).resolves.toEqual(new Set(["pms.inbox.read", "pms.inbox.reply"]));
  });
  it.each([
    null,
    { ...definition, base_role_key: "hotel_owner" },
    { ...definition, default_permissions: ["finance.billing.manage"] },
  ])("rejects missing/mismatched/malformed definitions: %j", async (row) => {
    await expect(
      lockPmsInboxRolePermissions(client(row), "organization", actor),
    ).resolves.toBeNull();
  });
  it("preserves legacy permissions only for a null role reference", async () => {
    await expect(
      lockPmsInboxRolePermissions(client(), "organization", { ...actor, roleDefinitionId: null }),
    ).resolves.toEqual(new Set(["pms.inbox.read", "pms.inbox.reply", "finance.billing.manage"]));
  });
});
