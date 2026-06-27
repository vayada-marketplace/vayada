import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearAuthData, setAuthKitSession } from "../auth/sessionStore";
import { settingsService } from ".";

const originalAuthKitFlag = process.env.NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED;
const originalCompatibilityFlag = process.env.NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED;
const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;

describe("settingsService next-stack bootstrap data", () => {
  beforeEach(() => {
    const storage = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("legacy admin route should not be called");
      }),
    );
    process.env.NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED = "false";
    process.env.NEXT_PUBLIC_API_URL = "https://next-api.vayada.com";
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
    restoreEnv("NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED", originalAuthKitFlag);
    restoreEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", originalCompatibilityFlag);
    restoreEnv("NEXT_PUBLIC_API_URL", originalApiUrl);
  });

  it("uses scoped booking hotels instead of legacy admin setup routes", async () => {
    await expect(settingsService.listHotels()).resolves.toEqual([
      {
        id: "booking_hotel_alpenrose",
        name: "My Property",
        slug: "",
        location: "",
        country: "",
      },
    ]);
    await expect(settingsService.getSetupStatus()).resolves.toMatchObject({
      setup_complete: true,
      missing_fields: [],
    });
    await expect(settingsService.getPropertySettings()).rejects.toThrow(
      "Property settings are not available on next-api yet.",
    );
    expect(fetch).not.toHaveBeenCalled();
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
