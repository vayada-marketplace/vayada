import { EventEmitter } from "node:events";
import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import {
  grantFreshHotelSetupHelpers,
  HotelSetupHelperGrantInspection,
} from "./hotelSetupHelperOwnerGrants.js";

afterEach(() => vi.restoreAllMocks());

const roleOid = 42;
const login = "vayada_next_hotel_setup_org_0123456789abcdef_0123456789ab";
const parent = {
  member: roleOid,
  roleid: 7,
  parent: "vayada_next_hotel_setup_scope",
  inherit_option: true,
  set_option: false,
  admin_option: false,
  grantor_superuser: true,
};
const incoming = (edge: Record<string, unknown>) => ({
  member: 30,
  roleid: roleOid,
  parent: login,
  inherit_option: false,
  set_option: false,
  admin_option: true,
  grantor_superuser: true,
  ...edge,
});

/** Membership shapes only; helper bodies/ACLs are covered by the native fixtures. */
async function capture(membership: Array<Record<string, unknown>>) {
  const sql: string[] = [];
  class Owner extends EventEmitter {
    async connect() {}
    async end() {}
    escapeIdentifier(name: string) {
      return `"${name}"`;
    }
    async query(text: string) {
      sql.push(text);
      if (text.startsWith("SELECT current_user"))
        return {
          rows: [
            { principal: "vayada_target_prod_user", session: "vayada_target_prod_user", oid: 9 },
          ],
        };
      if (text.startsWith("SELECT to_jsonb(r)"))
        return {
          rows: [
            {
              role: {
                rolcanlogin: false,
                rolinherit: false,
                rolsuper: false,
                rolcreaterole: false,
                rolcreatedb: false,
                rolreplication: false,
                rolbypassrls: false,
                rolvaliduntil: null,
                rolconfig: null,
              },
            },
          ],
        };
      if (text.startsWith("SELECT EXISTS")) return { rows: [{ present: false }] };
      if (text.startsWith("SELECT m.*")) return { rows: membership };
      return { rows: [] };
    }
  }
  vi.spyOn(pg, "Client").mockImplementation(function () {
    return new Owner();
  } as unknown as typeof pg.Client);
  const holder = {
    query: vi.fn(async (text: string) =>
      text.includes("pg_locks") ? { rows: [{ held: true }] } : { rows: [{ "?column?": 1 }] },
    ),
  } as unknown as pg.Client;
  const result = grantFreshHotelSetupHelpers({
    ownerDatabaseUrl: `postgresql://vayada_target_prod_user:${"x".repeat(36)}@db.internal/test?sslmode=verify-full`,
    databaseEndpoint: "postgresql://db.internal/test",
    holder,
    login,
    roleOid,
    kind: "organization",
    signatures: ["platform.channex_management_worker_scope(text,text,uuid)"],
  });
  await expect(result).rejects.toBeInstanceOf(HotelSetupHelperGrantInspection);
  await expect(result).rejects.toMatchObject({
    receipt: { phase: "owner_preflight", commitAttempted: false, committed: false },
  });
  // Reaching the helper-function query means the membership shape was accepted.
  return sql.some((text) => text.includes("FROM pg_catalog.pg_proc p"));
}

it("accepts only a fresh role with no incoming edge and its exact parent edge", async () => {
  expect(await capture([parent])).toBe(true);
});

it.each([
  ["the vanilla PostgreSQL creator ADMIN edge", [parent, incoming({})]],
  ["two incoming edges", [parent, incoming({}), incoming({ member: 31 })]],
  ["an inheriting incoming edge", [parent, incoming({ inherit_option: true })]],
  ["a SET incoming edge", [parent, incoming({ set_option: true })]],
  ["a non-superuser grantor", [parent, incoming({ grantor_superuser: false })]],
  ["a non-creator member", [parent, incoming({ member: 99, admin_option: false })]],
  ["a missing parent edge", []],
  ["a SET parent edge", [{ ...parent, set_option: true }]],
  ["an ADMIN parent edge", [{ ...parent, admin_option: true }]],
  ["a different parent role", [{ ...parent, parent: "vayada_next_hotel_setup_property_scope" }]],
  ["two parent edges", [parent, { ...parent, roleid: 8 }]],
])("refuses %s before touching helper grants", async (_case, membership) => {
  expect(await capture(membership)).toBe(false);
});
