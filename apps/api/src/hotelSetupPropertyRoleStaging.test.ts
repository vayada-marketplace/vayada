import { EventEmitter } from "node:events";
import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import {
  lockHotelSetupPropertyBootstrapAuthority,
  stageHotelSetupPropertyRole,
} from "./hotelSetupPropertyRoleStaging.js";
import { lockHotelSetupMembership } from "./hotelSetupMembership.js";
import { lockHotelSetupCurrencyMembership } from "./hotelSetupCurrencyMembership.js";
vi.mock("./hotelSetupCurrencyMembership.js", () => ({ lockHotelSetupCurrencyMembership: vi.fn() }));
vi.mock("./hotelSetupMembership.js", () => ({ lockHotelSetupMembership: vi.fn() }));

const input = {
  adminDatabaseUrl: `postgresql://admin:${"a".repeat(36)}@db.internal/test?sslmode=verify-full`,
  databaseEndpoint: "postgresql://db.internal/test",
  scope: {
    propertyId: "10000000-0000-4000-8000-000000000001",
    organizationId: "10000000-0000-4000-8000-000000000002",
    actorUserId: "10000000-0000-4000-8000-000000000003",
    operation: "currency_ready" as const,
  },
};
afterEach(() => vi.restoreAllMocks());

it.each(["grantWarning", "transport", "commit", "helperMissing", "helperDefiner"])(
  "fails closed on %s",
  async (mode) => {
    const sql: string[] = [];
    const end = vi.fn().mockResolvedValue(undefined);
    class Client extends EventEmitter {
      async connect() {}
      escapeIdentifier(name: string) {
        return `"${name}"`;
      }
      end = end;
      async query(text: string) {
        sql.push(text);
        if (text.startsWith("GRANT INSERT") && mode === "grantWarning")
          this.emit("notice", { code: "01007" });
        if (text.startsWith("GRANT INSERT") && mode === "transport")
          this.emit("error", new Error("private-diagnostic"));
        if (text === "COMMIT" && mode === "commit")
          this.emit("error", new Error("private-diagnostic"));
        if (text.includes("left(rolname") || text.includes("SELECT database_login"))
          return { rows: [] };
        if (text.includes("SELECT NOT prosecdef AS safe"))
          return {
            rows:
              mode === "helperMissing" ? [] : [{ safe: mode !== "helperDefiner" }, { safe: true }],
          };
        return { rows: [{ oid: 42 }] };
      }
    }
    vi.spyOn(pg, "Client").mockImplementation(function () {
      return new Client();
    } as unknown as typeof pg.Client);
    vi.mocked(lockHotelSetupCurrencyMembership).mockResolvedValue(true);
    await expect(stageHotelSetupPropertyRole(input)).rejects.toThrow(
      mode === "commit" ? "staging requires recovery inspection" : "staging failed",
    );
    expect(sql.includes("COMMIT")).toBe(mode === "commit");
    expect(sql.at(-1)).toBe(mode === "commit" ? "COMMIT" : "ROLLBACK");
    expect(end).toHaveBeenCalledOnce();
  },
);

it("rejects invalid purpose, identity and transport before constructing a client", async () => {
  const constructor = vi.spyOn(pg, "Client");
  for (const invalid of [
    { ...input, scope: { ...input.scope, operation: "__proto__" } },
    { ...input, scope: { ...input.scope, propertyId: "not-a-uuid" } },
    {
      ...input,
      adminDatabaseUrl: input.adminDatabaseUrl.replace("sslmode=verify-full", "sslmode=disable"),
    },
    { ...input, adminDatabaseUrl: input.adminDatabaseUrl.replace("admin:", ":") },
    { ...input, scope: { ...input.scope, automatic: false } },
    { ...input, scope: { ...input.scope, automatic: true, operation: "currency" } },
  ])
    await expect(stageHotelSetupPropertyRole(invalid as typeof input)).rejects.toThrow(
      "staging failed",
    );
  expect(constructor).not.toHaveBeenCalled();
});

it.each([
  ["launch_settings", ["scope"]],
  ["currency_ready", ["source", "scope"]],
  ["feature_hub", ["source", "scope"]],
  ["currency", []],
] as const)(
  "grants only the proven invoker helpers for fresh %s roles",
  async (operation, helpers) => {
    const sql: string[] = [];
    class Client extends EventEmitter {
      async connect() {}
      async end() {}
      escapeIdentifier(name: string) {
        return `"${name}"`;
      }
      async query(text: string) {
        sql.push(text);
        if (text.includes("left(rolname") || text.includes("SELECT database_login"))
          return { rows: [] };
        if (text.includes("SELECT NOT prosecdef AS safe"))
          return { rows: helpers.map(() => ({ safe: true })) };
        return { rows: [{ oid: 42 }] };
      }
    }
    vi.spyOn(pg, "Client").mockImplementation(function () {
      return new Client();
    } as unknown as typeof pg.Client);
    vi.mocked(lockHotelSetupCurrencyMembership).mockResolvedValue(true);
    vi.mocked(lockHotelSetupMembership).mockResolvedValue({
      context: {
        actor: { internalUserId: input.scope.actorUserId, status: "active" },
        selectedOrganization: {
          organizationId: input.scope.organizationId,
          kind: "hotel_group",
          status: "active",
        },
        membership: { membershipId: input.scope.actorUserId, roleKey: "owner", status: "active" },
        linkedResources: [
          {
            product: "hotel_catalog",
            resourceType: "property",
            resourceId: input.scope.propertyId,
            relationship: "owner",
            status: "active",
          },
        ],
      },
      permissions: ["hotel_catalog.setup.manage"],
      scope: {
        mode: "all",
        roleKey: "owner",
        accessOrigin: "agency",
        assignedPropertyIds: [],
        productAccess: { pms: true, booking: true },
      },
    } as Awaited<ReturnType<typeof lockHotelSetupMembership>>);
    const role = await stageHotelSetupPropertyRole({
      ...input,
      scope: { ...input.scope, operation },
    });
    expect(sql.filter((text) => text.startsWith("GRANT EXECUTE"))).toEqual(
      helpers.map(
        (helper) =>
          `GRANT EXECUTE ON FUNCTION platform.channex_management_worker_${helper}(text,text,uuid) TO "${role.login}"`,
      ),
    );
    expect(sql.at(-1)).toBe("COMMIT");
  },
);

it.each([
  "success",
  "intent",
  "bookingLink",
  "bookingOff",
  "pmsOff",
  "bookingSuspended",
  "pmsSuspended",
  "bookingBilling",
  "pmsBilling",
  "billingEnded",
  "clock",
  "futureBill",
  "unrelatedBilling",
  "unrelatedEntitlement",
])("rechecks online eligibility under current locks on %s", async (mode) => {
  vi.mocked(lockHotelSetupMembership).mockResolvedValue({
    scope: {
      productAccess: {
        pms: mode !== "pmsOff",
        booking: mode !== "bookingOff",
      },
    },
  } as Awaited<ReturnType<typeof lockHotelSetupMembership>>);
  vi.mocked(lockHotelSetupCurrencyMembership).mockResolvedValue(true);
  const query = vi.fn(async (sql: string) => {
    expect(sql === "SELECT pg_catalog.clock_timestamp() AS at" || sql.includes("FOR ")).toBe(true);
    if (sql.includes("organization_setup_track_intents"))
      return {
        rows: [
          {
            selected_tracks: mode === "intent" ? ["creator_marketplace"] : ["hotel_operations"],
          },
        ],
      };
    if (sql.startsWith("SELECT resource_id")) return { rows: mode === "bookingLink" ? [] : [{}] };
    if (sql.includes("FROM identity.product_entitlements"))
      return {
        rows: ["pms", "booking"].flatMap((product) => {
          const active = {
            product,
            key: product === "pms" ? "property-management" : "booking-engine",
            status: "active",
            resourceId: null,
            resourceProduct: null,
            resourceType: null,
            startsAt: null,
            expiresAt: null,
          };
          return mode === product + "Suspended"
            ? [active, { ...active, key: "account_access", status: "suspended" }]
            : mode === "unrelatedEntitlement"
              ? [
                  active,
                  {
                    ...active,
                    key: "account_access",
                    status: "suspended",
                    resourceProduct: product,
                    resourceType: product === "pms" ? "pms_property" : "booking_hotel",
                    resourceId: input.scope.organizationId,
                  },
                ]
              : [active];
        }),
      };
    if (sql.includes("FROM finance.billing_entitlements"))
      return {
        rows:
          mode.endsWith("Billing") || mode === "billingEnded" || mode === "futureBill"
            ? [
                {
                  product: mode === "bookingBilling" ? "booking" : "pms",
                  key: mode === "bookingBilling" ? "booking-engine" : "property-management",
                  propertyId: mode === "unrelatedBilling" ? input.scope.organizationId : null,
                  status: ["billingEnded", "futureBill"].includes(mode) ? "active" : "past_due",
                  startsAt: mode === "futureBill" ? new Date(Date.now() + 60000) : null,
                  expiresAt: mode === "billingEnded" ? new Date(0) : null,
                },
              ]
            : [],
      };
    if (sql === "SELECT pg_catalog.clock_timestamp() AS at")
      return {
        rows: [
          {
            at: mode === "clock" ? "bad-clock" : new Date(),
          },
        ],
      };
    return { rows: [{}] };
  });
  const result = lockHotelSetupPropertyBootstrapAuthority({ query } as unknown as pg.Client, {
    ...input.scope,
    automatic: true,
  });
  if (["success", "unrelatedBilling", "unrelatedEntitlement"].includes(mode))
    await expect(result).resolves.toBeUndefined();
  else await expect(result).rejects.toThrow();
  expect(query.mock.calls[0]![0]).toContain("FROM identity.organizations");
  expect(query.mock.calls[0]![0]).toContain("FOR UPDATE");
});
