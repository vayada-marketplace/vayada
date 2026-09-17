/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ApiError } from "@/services/api/client";
import { HotelProvider, useHotel, useRooms } from "./HotelContext";

const { getHotel, getRooms, getAddons } = vi.hoisted(() => ({
  getHotel: vi.fn(),
  getRooms: vi.fn(),
  getAddons: vi.fn(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/components/AffiliateClickTracker", () => ({ AffiliateClickTracker: () => null }));
vi.mock("@/services/api/hotel", () => ({
  hotelService: {
    getHotel,
    getRooms,
    getAddons,
  },
}));

it("keeps the hotel page available when initial pricing is unavailable", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  getHotel.mockResolvedValue({ slug: "pricing-test", name: "Pricing Test Hotel" });
  getRooms.mockRejectedValue(
    new ApiError("Pricing is unavailable", 503, { code: "PRICING_UNAVAILABLE" }),
  );
  getAddons.mockResolvedValue([]);
  const container = document.createElement("div");
  const root = createRoot(container);
  let result: { hotelName?: string; roomCount?: number; searchMessage?: string | null } = {};

  function Probe() {
    const { hotel } = useHotel();
    const { rooms, searchMessage } = useRooms();
    result = { hotelName: hotel.name, roomCount: rooms.length, searchMessage };
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

    expect(result).toEqual({
      hotelName: "Pricing Test Hotel",
      roomCount: 0,
      searchMessage: "availabilityError",
    });
    expect(container.textContent).toBe("Pricing Test Hotel");
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});

it("keeps unexpected initial offer failures fatal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  getHotel.mockResolvedValue({ slug: "pricing-test", name: "Pricing Test Hotel" });
  getRooms.mockRejectedValue(new ApiError("Unexpected failure", 500, { code: "INTERNAL_ERROR" }));
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
