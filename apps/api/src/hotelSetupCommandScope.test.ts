import { describe, expect, it } from "vitest";

import { withHotelSetupCommandScope } from "./hotelSetupCommandScope.js";

const propertyId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const scope = { propertyId, organizationId, operation: "currency_ready" as const };
const accepted = {
  sessionUser: "vayada_next_hotel_setup_property_ready_1",
  currentUser: "vayada_next_hotel_setup_property_ready_1",
  allowed: true,
  organizationAllowed: true,
  safeRole: true,
};

function setupPool(change: Partial<typeof accepted> = {}) {
  const calls: { sql: string; values?: readonly unknown[] }[] = [];
  let released = false;
  const client = {
    async query<T>(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, values });
      return {
        rows: sql.startsWith("SELECT") ? ([{ ...accepted, ...change }] as T[]) : ([] as T[]),
      };
    },
    release() {
      released = true;
    },
  };
  return {
    pool: {
      async connect() {
        return client;
      },
    },
    client,
    calls,
    isReleased: () => released,
  };
}

describe("hotel setup command transaction scope", () => {
  it("holds scope locks through the write and commits on the same client", async () => {
    const setup = setupPool();
    await expect(
      withHotelSetupCommandScope(setup.pool, scope, async (client) => {
        expect(client).toBe(setup.client);
        expect(setup.calls.map((call) => call.sql)).toEqual([
          "BEGIN",
          expect.stringContaining("platform.hotel_setup_property_operation_allowed"),
        ]);
        await client.query("INSERT INTO finance.expense_categories ...");
        return "saved";
      }),
    ).resolves.toBe("saved");
    expect(setup.calls.map((call) => call.sql)).toEqual([
      "BEGIN",
      expect.stringContaining("platform.hotel_setup_property_operation_allowed"),
      "INSERT INTO finance.expense_categories ...",
      "COMMIT",
    ]);
    expect(setup.calls[1]!.values).toEqual([propertyId, organizationId, "currency_ready"]);
    expect(setup.isReleased()).toBe(true);
  });

  it.each([
    { currentUser: "migration_owner" },
    { sessionUser: "ordinary_api", currentUser: "ordinary_api" },
    { allowed: false },
    { organizationAllowed: false },
    { safeRole: false },
  ])("rolls back a mismatched or unsafe database session: %j", async (change) => {
    const setup = setupPool(change);
    await expect(
      withHotelSetupCommandScope(setup.pool, scope, async () => {
        throw new Error("write must not run");
      }),
    ).rejects.toThrow("Hotel setup command scope preflight failed");
    expect(setup.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(setup.isReleased()).toBe(true);
  });

  it("rolls back failed writes", async () => {
    const setup = setupPool();
    await expect(
      withHotelSetupCommandScope(setup.pool, scope, async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");
    expect(setup.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(setup.isReleased()).toBe(true);
  });
});
