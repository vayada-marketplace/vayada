/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { HotelProvider, useAddons, useHotel } from "./HotelContext";

const { getHotel, getAddons } = vi.hoisted(() => ({
  getHotel: vi.fn(),
  getAddons: vi.fn(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/components/AffiliateClickTracker", () => ({ AffiliateClickTracker: () => null }));
vi.mock("@/services/api/hotel", () => ({ hotelService: { getHotel, getAddons } }));

it("loads the hotel profile and its add-on catalogue", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  getHotel.mockResolvedValue({ slug: "pricing-test", name: "Pricing Test Hotel" });
  getAddons.mockResolvedValue([{ id: "breakfast", name: "Breakfast" }]);
  const container = document.createElement("div");
  const root = createRoot(container);
  let result: { hotelName?: string; addonIds?: string[] } = {};

  function Probe() {
    const { hotel } = useHotel();
    const { addons } = useAddons();
    result = { hotelName: hotel.name, addonIds: addons.map((addon) => addon.id) };
    return createElement("p", null, hotel.name);
  }

  try {
    await act(async () => {
      root.render(
        <HotelProvider slug="pricing-test">
          <Probe />
        </HotelProvider>,
      );
    });

    expect(result).toEqual({ hotelName: "Pricing Test Hotel", addonIds: ["breakfast"] });
    expect(container.textContent).toBe("Pricing Test Hotel");
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});

it("keeps hotel load failures fatal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  getHotel.mockRejectedValue(new Error("Unexpected failure"));
  getAddons.mockResolvedValue([]);
  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <HotelProvider slug="pricing-test">
          <p>Hotel content</p>
        </HotelProvider>,
      );
    });

    expect(container.textContent).toContain("Unable to Load Hotel");
    expect(container.textContent).toContain("Unexpected failure");
    expect(container.textContent).not.toContain("Hotel content");
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
