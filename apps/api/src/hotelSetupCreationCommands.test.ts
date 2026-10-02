import { AuthorizationError } from "@vayada/backend-authorization";
import { beforeEach, expect, it, vi } from "vitest";
import { createHotelSetupCreationCommands } from "./hotelSetupCreationCommands.js";
import { createPgSharedHotelSetupStatusRepository } from "./platform/sharedHotelSetupStatusReadModel.js";
import type { SharedHotelSetupStatusRepository } from "./routes/sharedHotelSetupStatus.js";

vi.mock("./platform/sharedHotelSetupStatusReadModel.js", () => ({
  createPgSharedHotelSetupStatusRepository: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());
const organizationId = "11111111-1111-4111-8111-111111111111";
const login = "vayada_next_hotel_setup_org_test";

function fixture() {
  const query = vi.fn().mockResolvedValue({ rows: [{ organizationId, databaseLogin: login }] });
  const get = vi.fn().mockResolvedValue({ username: login, password: "x".repeat(32) });
  const save = vi.fn().mockResolvedValue({ propertyId: organizationId });
  const close = vi.fn().mockResolvedValue(undefined);
  vi.mocked(createPgSharedHotelSetupStatusRepository).mockReturnValue({
    createPropertyProfile: save,
    close,
  } as unknown as SharedHotelSetupStatusRepository);
  const commands = createHotelSetupCreationCommands({
    assignments: { query },
    vault: { get },
    databaseEndpoint: "postgresql://database.internal/target",
    secretPrefix: "hotel-setup-command/prod/organization/",
  });
  const input = { organizationId } as Parameters<typeof commands.createPropertyProfile>[0];
  return { query, get, save, close, commands, input };
}

it("reselects native credentials on each command and always closes the scoped repository", async () => {
  const f = fixture();
  await f.commands.createPropertyProfile(f.input);
  await f.commands.createPropertyProfile(f.input);
  expect(f.query).toHaveBeenCalledTimes(2);
  expect(f.get).toHaveBeenCalledTimes(2);
  expect(f.save).toHaveBeenCalledWith(f.input);
  expect(f.close).toHaveBeenCalledTimes(2);
  const config = vi.mocked(createPgSharedHotelSetupStatusRepository).mock.calls[0]![0];
  expect(config).toMatchObject({ max: 1, hotelSetupNativeCreation: true });
  expect(new URL(config.connectionString).username).toBe(login);
});

it("fails closed without a native assignment", async () => {
  const f = fixture();
  f.query.mockResolvedValue({ rows: [] });
  await expect(f.commands.createPropertyProfile(f.input)).rejects.toThrow(
    "Hotel setup property creation unavailable",
  );
  expect(f.get).not.toHaveBeenCalled();
  expect(createPgSharedHotelSetupStatusRepository).not.toHaveBeenCalled();
});

it.each(["idempotency_key_conflict", "command_in_progress"])(
  "preserves only the safe retry conflict %s",
  async (code) => {
    const f = fixture();
    f.save.mockRejectedValue(Object.assign(new Error("secret database detail"), { code }));
    await expect(f.commands.createPropertyProfile(f.input)).rejects.toMatchObject({
      message: code,
      code,
    });
    expect(f.close).toHaveBeenCalledOnce();
  },
);

it("preserves authorization denial and sanitizes unexpected failures", async () => {
  const f = fixture();
  const denied = new AuthorizationError("denied");
  f.save.mockRejectedValueOnce(denied).mockRejectedValueOnce(new Error("secret database detail"));
  await expect(f.commands.createPropertyProfile(f.input)).rejects.toBe(denied);
  await expect(f.commands.createPropertyProfile(f.input)).rejects.toThrow(
    "Hotel setup property creation unavailable",
  );
  expect(f.close).toHaveBeenCalledTimes(2);
});
