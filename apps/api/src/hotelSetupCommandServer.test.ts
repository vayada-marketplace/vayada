import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const close = vi.fn();
  const listen = vi.fn();
  return {
    config: {
      host: "127.0.0.1",
      port: 8011,
      readerDatabaseUrl: "private-reader-url",
      databaseEndpoint: "password-free-endpoint",
      secretPrefix: "private-prefix/",
      internalToken: "internal",
      workosJwksUrl: "jwks",
      workosIssuer: "issuer",
      workosAudience: "audience",
    },
    load: vi.fn(),
    preflight: vi.fn(),
    privileges: vi.fn(),
    runtimeClose: vi.fn(),
    pool: vi.fn(),
    get: vi.fn(),
    broadWrite: vi.fn(),
    currency: vi.fn(),
    toggle: vi.fn(),
    list: vi.fn(),
    ready: vi.fn(),
    identity: vi.fn(),
    verifier: vi.fn(),
    role: vi.fn(),
    entitlements: vi.fn(),
    access: vi.fn(),
    app: { listen, close, addHook: vi.fn() },
    build: vi.fn(),
    signals: vi.fn(),
  };
});
vi.mock("pg", () => ({
  default: {
    Pool: class {
      constructor(config: unknown) {
        mocks.pool(config);
      }
    },
  },
}));
vi.mock("@vayada/backend-auth", () => ({
  createPgIdentityRepository: mocks.identity,
  createWorkOSVerifier: mocks.verifier,
}));
vi.mock("@vayada/backend-authorization", () => ({
  createPgRolePermissionRepository: mocks.role,
  createPgEntitlementRepository: mocks.entitlements,
  createPgPropertyAccessRepository: mocks.access,
}));
vi.mock("./hotelSetupCommandServiceConfig.js", () => ({
  loadHotelSetupCommandServiceConfig: mocks.load,
  assertHotelSetupServiceReader: mocks.preflight,
}));
vi.mock("./hotelSetupReaderPrivileges.js", () => ({
  assertHotelSetupReaderPrivileges: mocks.privileges,
}));
vi.mock("./platform/postgresRuntime.js", () => ({
  installPostgresPoolRuntime: () => ({ close: mocks.runtimeClose }),
}));
vi.mock("./platform/providerCredentialVault.js", () => ({
  createSecretsManagerProviderCredentialVault: () => ({
    get: mocks.get,
    put: vi.fn(),
    delete: vi.fn(),
  }),
}));
vi.mock("./hotelSetupCurrencyCommands.js", () => ({
  createHotelSetupCurrencyCommands: mocks.currency,
}));
vi.mock("./hotelSetupFeatureHubCommands.js", () => ({
  createHotelSetupFeatureHubCommands: mocks.toggle,
}));
vi.mock("./routes/pmsModuleActivations.js", () => ({
  createPgPmsModuleActivationRepository: () => ({
    list: mocks.list,
    isFinancialsSetupComplete: mocks.ready,
    updateFinancials: mocks.broadWrite,
  }),
}));
vi.mock("./hotelSetupCommandService.js", () => ({ buildHotelSetupCommandService: mocks.build }));
vi.mock("./platform/shutdown.js", () => ({ registerShutdownSignals: mocks.signals }));

describe("private hotel setup executable", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.load.mockReturnValue(mocks.config);
    mocks.preflight.mockResolvedValue(undefined);
    mocks.privileges.mockResolvedValue(undefined);
    mocks.app.listen.mockResolvedValue(undefined);
    mocks.app.close.mockResolvedValue(undefined);
    mocks.runtimeClose.mockResolvedValue(undefined);
    mocks.build.mockReturnValue(mocks.app);
    mocks.currency.mockReturnValue({ upsertPropertyPricingCurrency: vi.fn() });
    mocks.toggle.mockReturnValue({ updateFinancials: vi.fn() });
  });

  it("wires native commands and reader-only Feature Hub ports after preflight", async () => {
    await import("./hotelSetupCommandServer.js");
    expect(mocks.pool).toHaveBeenCalledWith({ connectionString: "private-reader-url" });
    expect(mocks.preflight.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.build.mock.invocationCallOrder[0]!,
    );
    const options = mocks.build.mock.calls[0]![0];
    expect(options.featureHub).toEqual({
      reads: { list: mocks.list },
      setupComplete: mocks.ready,
      commands: mocks.toggle.mock.results[0]!.value,
    });
    expect(options.currencyCommands).toBe(mocks.currency.mock.results[0]!.value);
    expect(mocks.currency.mock.calls[0]![0].vault).toEqual({ get: mocks.get });
    expect(mocks.toggle.mock.calls[0]![0].vault).toEqual({ get: mocks.get });
    for (const repository of [mocks.identity, mocks.role, mocks.entitlements, mocks.access])
      expect(repository).toHaveBeenCalledWith({ connectionString: "private-reader-url" });
    expect(mocks.broadWrite).not.toHaveBeenCalled();
    expect(mocks.app.listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 8011 });
    await mocks.app.addHook.mock.calls[0]![1]();
    expect(mocks.runtimeClose).toHaveBeenCalledOnce();
  });

  it("rejects invalid configuration before constructing pools", async () => {
    mocks.load.mockImplementationOnce(() => {
      throw new Error("missing private config");
    });
    await expect(import("./hotelSetupCommandServer.js")).rejects.toThrow("missing private config");
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("closes pools and sanitizes failed preflight before opening a listener", async () => {
    mocks.preflight.mockRejectedValueOnce(new Error("sensitive database diagnostic"));
    await expect(import("./hotelSetupCommandServer.js")).rejects.toThrow(
      "Hotel setup command service startup failed",
    );
    expect(mocks.runtimeClose).toHaveBeenCalledOnce();
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("closes the app when the listener fails", async () => {
    mocks.app.listen.mockRejectedValueOnce(new Error("bind failure"));
    await expect(import("./hotelSetupCommandServer.js")).rejects.toThrow(
      "Hotel setup command service startup failed",
    );
    expect(mocks.app.close).toHaveBeenCalledOnce();
    expect(mocks.runtimeClose).toHaveBeenCalled();
  });

  it("rejects broad reader privileges before building or listening", async () => {
    mocks.privileges.mockRejectedValueOnce(new Error("reader ACL mismatch"));
    await expect(import("./hotelSetupCommandServer.js")).rejects.toThrow(
      "Hotel setup command service startup failed",
    );
    expect(mocks.runtimeClose).toHaveBeenCalledOnce();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.app.listen).not.toHaveBeenCalled();
  });
});
