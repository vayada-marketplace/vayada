import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearAuthData, getScopedBookingHotelIds, setAuthKitSession } from "./sessionStore";

const originalCompatibilityFlag = process.env.NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED;

describe("sessionStore booking resource scope", () => {
  beforeEach(() => {
    const storage = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage });
    process.env.NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED = "false";
  });

  afterEach(() => {
    clearAuthData();
    vi.unstubAllGlobals();
    if (originalCompatibilityFlag === undefined) {
      delete process.env.NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED = originalCompatibilityFlag;
    }
  });

  it("reads booking hotel scope from the AuthKit session response when access is opaque", () => {
    setAuthKitSession({
      accessToken: "workos-access-token",
      resources: { "booking:booking_hotel": ["booking_hotel_alpenrose"] },
      user: {
        id: "user_1",
        email: "owner@example.com",
        status: "active",
      },
    });

    expect(getScopedBookingHotelIds()).toEqual(["booking_hotel_alpenrose"]);
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
