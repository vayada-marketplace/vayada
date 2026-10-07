import type pg from "pg";
import { beforeEach, expect, it, vi } from "vitest";
import { checkHotelSetupPropertyCredential } from "./hotelSetupPropertyPreflight.js";
import { assertHotelSetupCommandScope } from "../hotelSetupCommandScope.js";
import { assertHotelSetupLaunchSettingsPrivileges } from "../hotelSetupLaunchSettingsPrivileges.js";
import { assertHotelSetupDatabaseIsolation } from "./hotelSetupReaderPreflight.js";

vi.mock("../hotelSetupCommandScope.js", () => ({ assertHotelSetupCommandScope: vi.fn() }));
vi.mock("../hotelSetupLaunchSettingsPrivileges.js", () => ({
  assertHotelSetupLaunchSettingsPrivileges: vi.fn(),
}));
vi.mock("./hotelSetupReaderPreflight.js", () => ({ assertHotelSetupDatabaseIsolation: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const scope = {
  propertyId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  operation: "launch_settings" as const,
};

it("attests isolation and exact launch ACLs before invoking scope helpers and never commits", async () => {
  const events: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      events.push(sql);
    }),
  } as unknown as pg.Client;
  vi.mocked(assertHotelSetupDatabaseIsolation).mockImplementation(async () => {
    events.push("isolation");
  });
  vi.mocked(assertHotelSetupLaunchSettingsPrivileges).mockImplementation(async () => {
    events.push("privileges");
  });
  vi.mocked(assertHotelSetupCommandScope).mockImplementation(async () => {
    events.push("scope");
  });
  await checkHotelSetupPropertyCredential(client, scope);
  expect(events).toEqual([
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "isolation",
    "privileges",
    "ROLLBACK",
    "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE",
    "scope",
    "ROLLBACK",
  ]);
  expect(assertHotelSetupCommandScope).toHaveBeenCalledWith(client, scope);
});
it.each(["isolation", "privileges", "scope"])(
  "rolls back %s failure without running subsequent stages",
  async (stage) => {
    const checks = {
      isolation: assertHotelSetupDatabaseIsolation,
      privileges: assertHotelSetupLaunchSettingsPrivileges,
      scope: assertHotelSetupCommandScope,
    };
    vi.mocked(checks[stage as keyof typeof checks]).mockRejectedValueOnce(new Error("rejected"));
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(
      checkHotelSetupPropertyCredential({ query } as unknown as pg.Client, scope),
    ).rejects.toThrow("rejected");
    expect(query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
    expect(query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    if (stage !== "scope") expect(assertHotelSetupCommandScope).not.toHaveBeenCalled();
    if (stage === "isolation")
      expect(assertHotelSetupLaunchSettingsPrivileges).not.toHaveBeenCalled();
  },
);
