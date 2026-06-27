import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pmsClientMock = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("./pmsClient", () => ({
  pmsClient: pmsClientMock,
}));

describe("moduleActivationClient", () => {
  beforeEach(() => {
    vi.resetModules();
    pmsClientMock.get.mockReset();
    pmsClientMock.patch.mockReset();
    const storage = createMemoryStorage();
    storage.setItem("selectedHotelId", "booking_hotel_alpenrose");
    vi.stubGlobal("window", { localStorage: storage });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses static next-stack activations instead of the legacy PMS route", async () => {
    vi.stubEnv("NEXT_PUBLIC_PMS_URL", "https://next-api.vayada.com");
    const { moduleActivationClient } = await import("./moduleActivationClient");

    const response = await moduleActivationClient.list();
    expect(pmsClientMock.get).not.toHaveBeenCalled();
    expect(pmsClientMock.patch).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      hotelId: "booking_hotel_alpenrose",
      activeModules: ["affiliates"],
      activations: [{ moduleId: "affiliates", isActive: true }],
    });
    await expect(moduleActivationClient.update("affiliates", false)).rejects.toThrow(
      "Module activation update for affiliates is not supported",
    );
    expect(pmsClientMock.patch).not.toHaveBeenCalled();
  });

  it("keeps normal PMS module activation requests on non-next targets", async () => {
    vi.stubEnv("NEXT_PUBLIC_PMS_URL", "https://pms-api.vayada.com");
    pmsClientMock.get.mockResolvedValue({
      hotelId: "hotel_1",
      activeModules: ["affiliates"],
      activations: [],
    });
    pmsClientMock.patch.mockResolvedValue({
      moduleId: "affiliates",
      isActive: true,
      activatedAt: null,
      deactivatedAt: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const { moduleActivationClient } = await import("./moduleActivationClient");

    await expect(moduleActivationClient.list()).resolves.toMatchObject({
      hotelId: "hotel_1",
    });
    await expect(moduleActivationClient.update("affiliates", true)).resolves.toMatchObject({
      moduleId: "affiliates",
      isActive: true,
    });

    expect(pmsClientMock.get).toHaveBeenCalledWith("/admin/module-activations");
    expect(pmsClientMock.patch).toHaveBeenCalledWith("/admin/module-activations/affiliates", {
      moduleId: "affiliates",
      isActive: true,
    });
  });
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
