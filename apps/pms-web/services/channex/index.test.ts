import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  resolvePropertyId: vi.fn().mockResolvedValue("property-1"),
}));

vi.mock("@/services/api/pmsOperationsClient", () => ({
  pmsOperationsClient: { get: mocks.get },
  pmsOperationsRequestOptions: { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
}));
vi.mock("@/services/api/pmsPropertyClient", () => ({
  resolveSelectedPmsPropertyId: mocks.resolvePropertyId,
}));

import { channexService } from ".";

describe("target PMS Channex client", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads the complete property-scoped management snapshot", async () => {
    const snapshot = { contractVersion: "pms-channex-management.v1", channels: [] };
    mocks.get.mockResolvedValue(snapshot);
    await expect(channexService.getSnapshot()).resolves.toBe(snapshot);
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/channex",
      expect.anything(),
    );
  });

  it("lists the connected channels the calendar legend shows", async () => {
    const channels = [{ key: "airbnb", application: "airbnb", title: null, isActive: true }];
    mocks.get.mockResolvedValue({ channels });
    await expect(channexService.listChannels()).resolves.toEqual({ channels });
  });
});
