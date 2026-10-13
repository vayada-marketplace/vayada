/** @vitest-environment jsdom */
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { expect, it, vi } from "vitest";
import enMessages from "../messages/en.json";
import { ApiError } from "@/services/api/client";
import { HotelProvider, useAddons, useHotel } from "./HotelContext";

const { getHotel, getAddons } = vi.hoisted(() => ({
  getHotel: vi.fn(),
  getAddons: vi.fn(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/components/AffiliateClickTracker", () => ({ AffiliateClickTracker: () => null }));
vi.mock("@/services/api/hotel", () => ({ hotelService: { getHotel, getAddons } }));

async function renderProvider(children: ReactNode, slug?: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <HotelProvider slug={slug}>{children}</HotelProvider>
      </NextIntlClientProvider>,
    );
  });
  return {
    container,
    cleanup() {
      act(() => root.unmount());
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    },
  };
}

it("loads the hotel profile and its add-on catalogue", async () => {
  getHotel.mockResolvedValue({ slug: "pricing-test", name: "Pricing Test Hotel" });
  getAddons.mockResolvedValue([{ id: "breakfast", name: "Breakfast" }]);
  let result: { hotelName?: string; addonIds?: string[] } = {};

  function Probe() {
    const { hotel } = useHotel();
    const { addons } = useAddons();
    result = { hotelName: hotel.name, addonIds: addons.map((addon) => addon.id) };
    return createElement("p", null, hotel.name);
  }

  const { container, cleanup } = await renderProvider(<Probe />, "pricing-test");
  try {
    expect(result).toEqual({ hotelName: "Pricing Test Hotel", addonIds: ["breakfast"] });
    expect(container.textContent).toBe("Pricing Test Hotel");
  } finally {
    cleanup();
  }
});

it("tells guests the booking page isn't online when the hotel request answers 404", async () => {
  getHotel.mockRejectedValue(
    new ApiError("Something went wrong. Please try again.", 404, {
      statusCode: 404,
      error: "Not Found",
      message: "Booking Web hotel profile not found.",
    }),
  );
  getAddons.mockResolvedValue([]);

  const { container, cleanup } = await renderProvider(<p>Hotel content</p>, "pricing-test");
  try {
    expect(container.querySelector("h2")?.textContent).toBe(
      "This booking page isn't online right now",
    );
    expect(container.textContent).toContain("Please check back later.");
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).not.toContain("Something went wrong");
    expect(container.textContent).not.toContain("not found");
    expect(container.textContent).not.toContain("Hotel content");
  } finally {
    cleanup();
  }
});

it("shows the not-online message without Retry when no hotel slug resolves", async () => {
  const { container, cleanup } = await renderProvider(<p>Hotel content</p>);
  try {
    expect(getHotel).not.toHaveBeenCalled();
    expect(container.querySelector("h2")?.textContent).toBe(
      "This booking page isn't online right now",
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).not.toContain("No property is configured");
  } finally {
    cleanup();
  }
});

it("keeps a friendly retry message for server errors", async () => {
  getHotel.mockRejectedValue(
    new ApiError("Something went wrong. Please try again.", 503, {
      statusCode: 503,
      error: "Service Unavailable",
      message: "Service Unavailable",
    }),
  );
  getAddons.mockResolvedValue([]);

  const { container, cleanup } = await renderProvider(<p>Hotel content</p>, "pricing-test");
  try {
    expect(container.querySelector("h2")?.textContent).toBe("Unable to Load Hotel");
    expect(container.textContent).toContain("Please try again later.");
    expect(container.querySelector("button")?.textContent).toBe("Retry");
    expect(container.textContent).not.toContain("isn't online");
    expect(container.textContent).not.toContain("Hotel content");
  } finally {
    cleanup();
  }
});
