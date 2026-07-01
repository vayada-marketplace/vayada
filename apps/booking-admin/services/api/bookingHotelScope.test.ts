import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearAuthData, setAuthKitSession } from "../auth/sessionStore";
import { getSelectedBookingHotelId } from "./bookingHotelScope";

describe("bookingHotelScope", () => {
  beforeEach(() => {
    const storage = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage });
  });

  afterEach(() => {
    clearAuthData();
    vi.unstubAllGlobals();
  });

  it("auto-selects a single scoped Booking hotel", () => {
    setAuthKitSession({
      accessToken: "workos-access-token",
      resources: { "booking:booking_hotel": ["booking_hotel_alpenrose"] },
      user: {
        id: "user_1",
        email: "owner@example.com",
        status: "active",
      },
    });

    expect(getSelectedBookingHotelId()).toBe("booking_hotel_alpenrose");
    expect(localStorage.getItem("selectedHotelId")).toBe("booking_hotel_alpenrose");
  });

  it("does not trust a local hotel selection without scoped Booking resources", () => {
    localStorage.setItem("selectedHotelId", "stale_booking_hotel");

    expect(getSelectedBookingHotelId()).toBeNull();
    expect(localStorage.getItem("selectedHotelId")).toBeNull();
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
