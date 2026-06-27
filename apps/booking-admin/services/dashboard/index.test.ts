import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearAuthData, setAuthKitSession } from "../auth/sessionStore";
import { dashboardService } from ".";

const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;

describe("dashboardService target route adapter", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = "https://next-api.vayada.com";
    const storage = createMemoryStorage();
    storage.setItem("selectedHotelId", "stale_booking_hotel");
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage });
    setAuthKitSession({
      accessToken: "workos-access-token",
      resources: { "booking:booking_hotel": ["booking_hotel_alpenrose"] },
      user: {
        id: "user_1",
        email: "owner@example.com",
        status: "active",
      },
    });
  });

  afterEach(() => {
    clearAuthData();
    vi.unstubAllGlobals();
    restoreEnv("NEXT_PUBLIC_API_URL", originalApiUrl);
  });

  it("maps dashboard stats from the target booking route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          metrics: {
            current: {
              totalRevenue: { amountDecimal: "3600.00", currency: "EUR" },
              bookingCount: 10,
              avgNightlyRate: { amountDecimal: "120.00", currency: "EUR" },
            },
            previous: {
              totalRevenue: { amountDecimal: "2880.00", currency: "EUR" },
              bookingCount: 8,
              avgNightlyRate: { amountDecimal: "110.00", currency: "EUR" },
            },
            nextArrivalDate: "2026-07-04",
            liveSinceDate: "2025-01-15",
          },
        }),
      ),
    );

    const stats = await dashboardService.getStats("week");

    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(
      "/api/booking/properties/booking_hotel_alpenrose/dashboard/stats",
    );
    expect(localStorage.getItem("selectedHotelId")).toBe("booking_hotel_alpenrose");
    expect(stats).toMatchObject({
      revenue: 3600,
      revenue_previous: 2880,
      bookings: 10,
      bookings_previous: 8,
      avg_nightly_rate: 120,
      avg_nightly_rate_previous: 110,
      next_arrival: "2026-07-04",
      live_since: "2025-01-15",
    });
  });

  it("returns valid empty page-view windows until the target route exists", async () => {
    const timeline = await dashboardService.getPageViewsTimeline();

    expect(timeline.window_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(timeline.window_end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(timeline.previous_window_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(timeline.previous_window_end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(timeline.buckets).toEqual([]);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

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
