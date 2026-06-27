import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearAuthData,
  setAuthKitSession,
  setLegacyCompatibilityToken,
  setLegacyPasswordSession,
} from "../auth/sessionStore";
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
    vi.unstubAllEnvs();
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

  it("uses compatibility bearer only for non-next legacy admin routes", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    clearAuthData();
    setAuthKitSession({
      accessToken: "workos-token",
      user: {
        id: "user_1",
        email: "owner@example.com",
        status: "active",
      },
    });
    setLegacyCompatibilityToken("compatibility-token", 3600);
    const client = new ApiClient("https://target-api.vayada.com");

    await client.get("/admin/settings/property");
    expect(fetchHeaders()).toMatchObject({
      Authorization: "Bearer compatibility-token",
    });

    await client.get("/api/booking/hotels/booking_hotel_alpenrose/settings/addons");
    expect(fetchHeaders()).toMatchObject({
      Authorization: "Bearer workos-token",
    });
  });

  it("mints a compatibility bearer before non-next legacy admin routes", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    clearAuthData();
    setAuthKitSession({
      accessToken: "workos-token",
      csrfToken: "csrf-token",
      user: {
        id: "user_1",
        email: "owner@example.com",
        status: "active",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const href = String(url);
        if (href === "https://api.localhost/auth/compat/booking-admin-token") {
          expect(new Headers(init?.headers).get("x-vayada-csrf")).toBe("csrf-token");
          return new Response(
            JSON.stringify({ accessToken: "fresh-compatibility-token", expiresIn: 900 }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }),
    );
    const client = new ApiClient("https://target-api.vayada.com");

    await client.get("/admin/settings/property");

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetchHeaders()).toMatchObject({
      Authorization: "Bearer fresh-compatibility-token",
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
