import { afterEach, describe, expect, it, vi } from "vitest";

const apiClientMock = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));

const propertyLinkMock = vi.hoisted(() => vi.fn());

vi.mock("./client", () => ({
  apiClient: apiClientMock,
  omitHotelContext: { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
}));

vi.mock("./bookingHotelScope", () => ({
  getSelectedBookingHotelId: () => "booking_hotel_alpenrose",
}));

vi.mock("./bookingPropertyLinkClient", () => ({
  getBookingHotelPropertyLink: propertyLinkMock,
}));

describe("moduleActivationClient", () => {
  afterEach(() => {
    vi.resetModules();
    apiClientMock.get.mockReset();
    apiClientMock.patch.mockReset();
    propertyLinkMock.mockReset();
  });

  it("manages the PMS Inbox and Reviews switches beside Financials", async () => {
    const options = { headers: { "X-Vayada-Omit-Hotel-Context": "true" } };
    propertyLinkMock.mockResolvedValue({ propertyId: "pms_property_alpenrose" });
    apiClientMock.get.mockImplementation(async (url: string) => ({
      hotelId: "pms_property_alpenrose",
      canManage: true,
      supportedModules: url.endsWith("/navigation-modules") ? ["inbox", "reviews"] : ["financials"],
      activeModules: [],
      activations: [],
    }));
    apiClientMock.patch.mockImplementation(async (_url: string, body: object) => ({
      ...body,
      activatedAt: null,
      deactivatedAt: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));

    const { moduleActivationClient } = await import("./moduleActivationClient");

    await expect(moduleActivationClient.list()).resolves.toMatchObject({
      hotelId: "pms_property_alpenrose",
      supportedModules: ["inbox", "reviews", "financials"],
      manageableModules: ["inbox", "reviews", "financials"],
    });
    await expect(moduleActivationClient.update("inbox", true)).resolves.toMatchObject({
      moduleId: "inbox",
      isActive: true,
    });

    expect(propertyLinkMock).toHaveBeenCalledWith({ hotelId: "booking_hotel_alpenrose" });
    expect(apiClientMock.get.mock.calls).toEqual([
      ["/api/pms/properties/pms_property_alpenrose/navigation-modules", options],
      ["/api/pms/properties/pms_property_alpenrose/module-activations", options],
    ]);
    expect(apiClientMock.patch).toHaveBeenCalledExactlyOnceWith(
      "/api/pms/properties/pms_property_alpenrose/navigation-modules/inbox",
      { moduleId: "inbox", isActive: true },
      options,
    );
  });
});
