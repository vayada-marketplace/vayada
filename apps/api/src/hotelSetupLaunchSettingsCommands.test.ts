import type { RequestContext } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import pg from "pg";
import { beforeEach, expect, it, vi } from "vitest";
import { createHotelSetupLaunchSettingsCommands } from "./hotelSetupLaunchSettingsCommands.js";
import { writeHotelSetupLaunchSettings } from "./hotelSetupLaunchSettingsRepository.js";
import { BookingContactPublicationConflictError } from "./routes/bookingSettings.js";
vi.mock("pg", () => ({
  default: {
    Pool: vi.fn(function () {
      return { end: vi.fn() };
    }),
  },
}));
vi.mock("./hotelSetupLaunchSettingsRepository.js", () => ({
  writeHotelSetupLaunchSettings: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());
const propertyId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const login = "vayada_next_hotel_setup_property_launch_test";
const context = { selectedOrganization: { organizationId } } as RequestContext;
const settings = {
  defaultCurrency: "LKR",
  supportedCurrencies: [],
  defaultLanguage: "en",
  supportedLanguages: [],
  instagram: "",
  facebook: "",
  tiktok: "",
  youtube: "",
};
function fixture() {
  const query = vi.fn().mockResolvedValue({
    rows: [
      {
        propertyId,
        organizationId,
        databaseLogin: login,
        operation: "launch_settings",
        credentialRoleOid: 12345,
        actualRoleOid: 12345,
        credentialSecretVersion: "11111111-1111-4111-8111-111111111111",
        credentialReadyAt: new Date("2026-10-04T00:00:00Z"),
      },
    ],
  });
  const get = vi.fn().mockResolvedValue({ username: login, password: "p".repeat(48) });
  const close = vi.fn().mockResolvedValue(undefined);
  vi.mocked(pg.Pool).mockImplementation(function () {
    return { end: close } as unknown as pg.Pool;
  });
  vi.mocked(writeHotelSetupLaunchSettings).mockReset().mockResolvedValue(settings);
  return {
    query,
    get,
    close,
    commands: createHotelSetupLaunchSettingsCommands({
      assignments: { query },
      readNativeSecret: get,
      databaseEndpoint: "postgresql://db.example.test/target",
      secretPrefix: "hotel-setup-command/prod/property/",
    }),
  };
}
it("reselects launch credentials each time, uses one connection and closes every pool", async () => {
  const f = fixture();
  expect(await f.commands.updateLaunchSettings(context, propertyId, settings)).toEqual(settings);
  await f.commands.updateLaunchSettings(context, propertyId, settings);
  expect(f.query).toHaveBeenCalledTimes(2);
  expect(f.get).toHaveBeenCalledTimes(2);
  expect(f.close).toHaveBeenCalledTimes(2);
  const config = vi.mocked(pg.Pool).mock.calls[0]![0]!;
  expect(config.max).toBe(1);
  expect(new URL(config.connectionString!).username).toBe(login);
  expect(writeHotelSetupLaunchSettings).toHaveBeenCalledWith(
    expect.anything(),
    context,
    propertyId,
    settings,
  );
});
it("fails closed after assignment revocation without creating another pool", async () => {
  const f = fixture();
  await f.commands.updateLaunchSettings(context, propertyId, settings);
  f.query.mockResolvedValue({ rows: [] });
  await expect(f.commands.updateLaunchSettings(context, propertyId, settings)).rejects.toThrow(
    /^Hotel setup launch settings command unavailable$/,
  );
  expect(pg.Pool).toHaveBeenCalledOnce();
  expect(f.get).toHaveBeenCalledOnce();
});
it.each(["query", "get", "write", "close"])(
  "sanitizes %s errors and closes the opened pool",
  async (stage) => {
    const f = fixture();
    const mocks = {
      query: f.query,
      get: f.get,
      write: vi.mocked(writeHotelSetupLaunchSettings),
      close: f.close,
    };
    mocks[stage as keyof typeof mocks].mockRejectedValueOnce(new Error("credential detail"));
    await expect(f.commands.updateLaunchSettings(context, propertyId, settings)).rejects.toThrow(
      /^Hotel setup launch settings command unavailable$/,
    );
    if (stage === "write" || stage === "close") expect(f.close).toHaveBeenCalledOnce();
    else expect(pg.Pool).not.toHaveBeenCalled();
  },
);
it.each([new AuthorizationError(), new BookingContactPublicationConflictError()])(
  "preserves safe authorization and private-contact conflicts",
  async (error) => {
    const f = fixture();
    vi.mocked(writeHotelSetupLaunchSettings).mockRejectedValueOnce(error);
    await expect(f.commands.updateLaunchSettings(context, propertyId, settings)).rejects.toBe(
      error,
    );
    expect(f.close).toHaveBeenCalledOnce();
  },
);
