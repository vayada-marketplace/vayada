import { afterEach, describe, expect, it, vi } from "vitest";

const pmsOperationsClientMock = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));
const resolvePropertyMock = vi.hoisted(() => vi.fn());

vi.mock("./pmsOperationsClient", () => ({
  pmsOperationsClient: pmsOperationsClientMock,
  pmsOperationsRequestOptions: {
    headers: { "X-Vayada-Omit-Hotel-Context": "true" },
    cache: "no-store",
  },
}));

vi.mock("./pmsPropertyClient", () => ({
  resolveSelectedPmsPropertyId: resolvePropertyMock,
}));

describe("moduleActivationClient", () => {
  afterEach(() => {
    vi.resetModules();
    pmsOperationsClientMock.get.mockReset();
    pmsOperationsClientMock.patch.mockReset();
    resolvePropertyMock.mockReset();
  });

  it("reads both module stores and routes each switch to its own property-scoped route", async () => {
    const options = {
      headers: { "X-Vayada-Omit-Hotel-Context": "true" },
      cache: "no-store",
    };
    resolvePropertyMock.mockResolvedValue("pms_property_alpenrose");
    pmsOperationsClientMock.get.mockImplementation(async (url: string) =>
      url.endsWith("/navigation-modules")
        ? {
            hotelId: "pms_property_alpenrose",
            canManage: true,
            supportedModules: ["inbox", "reviews"],
            activeModules: ["inbox"],
            activations: [],
          }
        : {
            hotelId: "pms_property_alpenrose",
            canManage: false,
            supportedModules: ["financials"],
            activeModules: ["financials"],
            activations: [],
          },
    );
    pmsOperationsClientMock.patch.mockImplementation(async (_url: string, body: object) => ({
      ...body,
      activatedAt: "2026-10-09T00:00:00.000Z",
      deactivatedAt: null,
      updatedAt: "2026-10-09T00:00:00.000Z",
    }));

    const { moduleActivationClient } = await import("./moduleActivationClient");

    await expect(moduleActivationClient.list()).resolves.toMatchObject({
      hotelId: "pms_property_alpenrose",
      supportedModules: ["inbox", "reviews", "financials"],
      activeModules: ["inbox", "financials"],
      manageableModules: ["inbox", "reviews"],
    });
    await moduleActivationClient.update("reviews", true);
    await moduleActivationClient.update("financials", false);

    expect(resolvePropertyMock).toHaveBeenCalledWith("loading module activations");
    expect(resolvePropertyMock).toHaveBeenCalledWith("updating module activations");
    expect(pmsOperationsClientMock.get.mock.calls).toEqual([
      ["/api/pms/properties/pms_property_alpenrose/navigation-modules", options],
      ["/api/pms/properties/pms_property_alpenrose/module-activations", options],
    ]);
    expect(pmsOperationsClientMock.patch.mock.calls).toEqual([
      [
        "/api/pms/properties/pms_property_alpenrose/navigation-modules/reviews",
        { moduleId: "reviews", isActive: true },
        options,
      ],
      [
        "/api/pms/properties/pms_property_alpenrose/module-activations/financials",
        { moduleId: "financials", isActive: false },
        options,
      ],
    ]);
  });
});
