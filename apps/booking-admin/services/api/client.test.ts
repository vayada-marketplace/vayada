import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearAuthData, setLegacyPasswordSession } from "../auth/sessionStore";
import { ApiClient } from "./client";

describe("ApiClient hotel context header", () => {
  beforeEach(() => {
    const storage = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage, location: { href: "" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } })),
    );
    setLegacyPasswordSession({
      token: "booking-admin-token",
      expiresIn: 3600,
      user: {
        id: "user_1",
        email: "owner@example.com",
        name: "Owner",
        type: "hotel",
        status: "active",
      },
    });
    localStorage.setItem("selectedHotelId", "booking_hotel_alpenrose");
  });

  afterEach(() => {
    clearAuthData();
    vi.unstubAllGlobals();
  });

  it("keeps target resource routes free of the legacy hotel header", async () => {
    const client = new ApiClient("https://api.booking.localhost");

    await client.get("/api/booking/hotels/booking_hotel_alpenrose/settings/addons");

    expect(fetchHeaders()).not.toHaveProperty("X-Hotel-Id");
  });

  it("keeps sending the legacy hotel header to admin compatibility routes", async () => {
    const client = new ApiClient("https://api.booking.localhost");

    await client.get("/admin/settings/property");

    expect(fetchHeaders()).toMatchObject({
      "X-Hotel-Id": "booking_hotel_alpenrose",
    });
  });
});

function fetchHeaders(): Record<string, string> {
  const fetchMock = vi.mocked(fetch);
  const requestInit = fetchMock.mock.calls.at(-1)?.[1];
  return (requestInit?.headers ?? {}) as Record<string, string>;
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
