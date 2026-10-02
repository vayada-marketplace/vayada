import type { RequestContext } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import { beforeEach, expect, it, vi } from "vitest";
import { lockHotelSetupMembership } from "./hotelSetupMembership.js";
import { writeHotelSetupLaunchSettings } from "./hotelSetupLaunchSettingsRepository.js";
import { assertHotelSetupLaunchSettingsPrivileges } from "./hotelSetupLaunchSettingsPrivileges.js";

vi.mock("./hotelSetupMembership.js", () => ({ lockHotelSetupMembership: vi.fn() }));
vi.mock("./hotelSetupLaunchSettingsPrivileges.js", () => ({
  assertHotelSetupLaunchSettingsPrivileges: vi.fn(),
}));
vi.mock("@vayada/backend-authorization", async (original) => ({
  ...(await original<object>()),
  resolveEffectivePropertyAccess: vi.fn(async () => ({ propertyIds: [propertyId] })),
}));
const propertyId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const context = {
  actor: { internalUserId: organizationId, providerIdentity: { sessionId: "owner-session" } },
  selectedOrganization: { organizationId },
  audit: { requestId: "request", correlationId: null },
} as unknown as RequestContext;
const settings = {
  defaultCurrency: "LKR",
  supportedCurrencies: ["USD"],
  defaultLanguage: "en",
  supportedLanguages: [],
  instagram: "",
  facebook: "",
  tiktok: "",
  youtube: "",
};

beforeEach(() => {
  vi.mocked(assertHotelSetupLaunchSettingsPrivileges).mockReset().mockResolvedValue(undefined);
  vi.mocked(lockHotelSetupMembership)
    .mockReset()
    .mockResolvedValue({
      permissions: ["hotel_catalog.setup.manage"],
      context: {},
      scope: {},
    } as Awaited<ReturnType<typeof lockHotelSetupMembership>>);
});
it("denies changed native privileges before writes and rolls back", async () => {
  vi.mocked(assertHotelSetupLaunchSettingsPrivileges).mockRejectedValueOnce(
    new Error("unsafe privileges"),
  );
  const f = fixture();
  await expect(
    writeHotelSetupLaunchSettings(f.pool, context, propertyId, settings),
  ).rejects.toThrow("unsafe privileges");
  expect(f.statements).toEqual(["BEGIN", "ROLLBACK"]);
  expect(lockHotelSetupMembership).not.toHaveBeenCalled();
});
function fixture(options: { revoked?: boolean; conflict?: boolean; auditFailure?: boolean } = {}) {
  const statements: string[] = [];
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => {
    statements.push(sql);
    if (sql.includes('AS "sessionUser"'))
      return {
        rows: [
          {
            sessionUser: "vayada_next_hotel_setup_property_launch_test",
            currentUser: "vayada_next_hotel_setup_property_launch_test",
            allowed: !options.revoked,
            organizationAllowed: true,
            safeRole: true,
          },
        ],
      };
    if (sql.startsWith("SELECT contact.id"))
      return { rows: options.conflict ? [{ id: "private" }] : [] };
    if (sql.includes("INSERT INTO platform.product_audit_events") && options.auditFailure)
      throw new Error("audit rejected");
    if (sql.startsWith("SELECT settings.default_currency")) return { rows: [settings] };
    return { rows: sql.startsWith("SELECT") ? [{ id: propertyId }] : [] };
  });
  const pool = {
    connect: vi.fn(async () => ({
      async query<T>(sql: string) {
        return (await query(sql)) as { rows: T[] };
      },
      release,
    })),
  };
  return { pool, statements, release };
}
it("returns the scoped saved values and commits only after the audit succeeds", async () => {
  const f = fixture();
  expect(await writeHotelSetupLaunchSettings(f.pool, context, propertyId, settings)).toEqual(
    settings,
  );
  expect(f.statements[0]).toBe("BEGIN");
  expect(f.statements.at(-1)).toBe("COMMIT");
  expect(
    f.statements.findIndex((s) => s.includes("INSERT INTO platform.product_audit_events")),
  ).toBeLessThan(f.statements.findIndex((s) => s.startsWith("SELECT settings.default_currency")));
  expect(f.release).toHaveBeenCalledOnce();
});
it.each([{ revoked: true }, { conflict: true }, { auditFailure: true }])(
  "rolls back a revoked assignment, private contact conflict or audit failure: %j",
  async (options) => {
    const f = fixture(options);
    await expect(
      writeHotelSetupLaunchSettings(f.pool, context, propertyId, settings),
    ).rejects.toThrow();
    expect(f.statements.at(-1)).toBe("ROLLBACK");
    expect(f.statements).not.toContain("COMMIT");
    expect(f.release).toHaveBeenCalledOnce();
    if (options.revoked || options.conflict)
      expect(f.statements.some((sql) => sql.startsWith("UPDATE booking.booking_settings"))).toBe(
        false,
      );
  },
);
it("rejects a revoked member before writes and releases the transaction", async () => {
  vi.mocked(lockHotelSetupMembership).mockResolvedValueOnce(null);
  const f = fixture();
  await expect(
    writeHotelSetupLaunchSettings(f.pool, context, propertyId, settings),
  ).rejects.toBeInstanceOf(AuthorizationError);
  expect(f.statements.at(-1)).toBe("ROLLBACK");
  expect(f.statements).toHaveLength(3);
});
it("requires an original owner session before opening a database connection", async () => {
  const f = fixture();
  await expect(
    writeHotelSetupLaunchSettings(
      f.pool,
      {
        ...context,
        actor: {
          ...context.actor,
          providerIdentity: { ...context.actor.providerIdentity, sessionId: undefined },
        },
      },
      propertyId,
      settings,
    ),
  ).rejects.toBeInstanceOf(AuthorizationError);
  expect(f.pool.connect).not.toHaveBeenCalled();
});
