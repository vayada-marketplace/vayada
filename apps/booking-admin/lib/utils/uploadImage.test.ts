import { afterEach, describe, expect, it, vi } from "vitest";

type StoredValue = string | null;

describe("uploadImages", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("uses the legacy listing upload endpoint even when platform media is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_MEDIA_API_URL", "https://api.localhost");
    const window = createWindowWithStorage();
    vi.stubGlobal("window", window);
    vi.stubGlobal("localStorage", window.localStorage);

    const { setAuthKitSession, setLegacyCompatibilityToken } =
      await import("@/services/auth/sessionStore");
    const { uploadImages } = await import("./uploadImage");
    const authKitToken = unsignedJwt({
      resources: {
        "booking:booking_hotel": ["booking_hotel_alpenrose"],
      },
    });
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.vayada.com/upload/images/listing");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer legacy-token");
      expect(headers.get("content-type")).toBeNull();
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeInstanceOf(FormData);
      return jsonResponse({
        images: [{ url: "https://api.vayada.com/static/listings/room.jpg" }],
        total: 1,
      });
    });
    vi.stubGlobal("fetch", fetch);

    setAuthKitSession({
      accessToken: authKitToken,
      user: {
        id: "user_1",
        email: "owner@example.com",
        status: "active",
      },
    });
    setLegacyCompatibilityToken("legacy-token", 900);

    await expect(
      uploadImages(new File(["image"], "room.jpg", { type: "image/jpeg" })),
    ).resolves.toEqual(["https://api.vayada.com/static/listings/room.jpg"]);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the legacy hotel-profile upload endpoint for production hero images", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_MEDIA_API_URL", "https://api.vayada.com");
    const window = createWindowWithStorage();
    vi.stubGlobal("window", window);
    vi.stubGlobal("localStorage", window.localStorage);

    const { setAuthKitSession, setLegacyCompatibilityToken } =
      await import("@/services/auth/sessionStore");
    const { uploadSingleImage } = await import("./uploadImage");
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.vayada.com/upload/image/hotel-profile");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer legacy-token");
      expect(headers.get("content-type")).toBeNull();
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeInstanceOf(FormData);
      return jsonResponse({
        url: "https://api.vayada.com/static/hotels/hero.jpg",
        key: "hotel-profile/hero.jpg",
      });
    });
    vi.stubGlobal("fetch", fetch);

    setAuthKitSession({
      accessToken: "authkit-token",
      user: {
        id: "user_1",
        email: "owner@example.com",
        status: "pending_verification",
      },
    });
    setLegacyCompatibilityToken("legacy-token", 900);

    await expect(
      uploadSingleImage(
        new File(["image"], "hero.jpg", { type: "image/jpeg" }),
        "property.hero_image",
      ),
    ).resolves.toBe("https://api.vayada.com/static/hotels/hero.jpg");

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the legacy listing upload endpoint for production gallery images", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_MEDIA_API_URL", "https://api.vayada.com");
    const window = createWindowWithStorage();
    vi.stubGlobal("window", window);
    vi.stubGlobal("localStorage", window.localStorage);

    const { setLegacyCompatibilityToken } = await import("@/services/auth/sessionStore");
    const { uploadImages } = await import("./uploadImage");
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.vayada.com/upload/images/listing");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer legacy-token");
      expect(headers.get("content-type")).toBeNull();
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeInstanceOf(FormData);
      return jsonResponse({
        images: [
          { url: "https://api.vayada.com/static/listings/room-1.jpg" },
          { url: "https://api.vayada.com/static/listings/room-2.jpg" },
        ],
        total: 2,
      });
    });
    vi.stubGlobal("fetch", fetch);

    setLegacyCompatibilityToken("legacy-token", 900);

    await expect(
      uploadImages([
        new File(["image"], "room-1.jpg", { type: "image/jpeg" }),
        new File(["image"], "room-2.jpg", { type: "image/jpeg" }),
      ]),
    ).resolves.toEqual([
      "https://api.vayada.com/static/listings/room-1.jpg",
      "https://api.vayada.com/static/listings/room-2.jpg",
    ]);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails legacy hero uploads when the response does not include a URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_MEDIA_API_URL", "https://api.vayada.com");

    const { setLegacyCompatibilityToken } = await import("@/services/auth/sessionStore");
    const { uploadSingleImage } = await import("./uploadImage");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ key: "hotel-profile/hero.jpg" })),
    );

    setLegacyCompatibilityToken("legacy-token", 900);

    await expect(
      uploadSingleImage(
        new File(["image"], "hero.jpg", { type: "image/jpeg" }),
        "property.hero_image",
      ),
    ).rejects.toThrow("Upload failed: no image URL returned");
  });

  it("fails legacy gallery uploads when any uploaded image has no URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_MEDIA_API_URL", "https://api.vayada.com");

    const { setLegacyCompatibilityToken } = await import("@/services/auth/sessionStore");
    const { uploadImages } = await import("./uploadImage");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          images: [
            { url: "https://api.vayada.com/static/listings/room-1.jpg" },
            { key: "listing/missing-url.jpg" },
          ],
        }),
      ),
    );

    setLegacyCompatibilityToken("legacy-token", 900);

    await expect(
      uploadImages([
        new File(["image"], "room-1.jpg", { type: "image/jpeg" }),
        new File(["image"], "room-2.jpg", { type: "image/jpeg" }),
      ]),
    ).rejects.toThrow("Upload failed: no image URL returned");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function unsignedJwt(payload: Record<string, unknown>): string {
  return ["header", base64Url(JSON.stringify(payload)), "signature"].join(".");
}

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createWindowWithStorage(): Window {
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string): StoredValue => storage.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      storage.set(key, value);
    },
    removeItem: (key: string): void => {
      storage.delete(key);
    },
  };

  return { localStorage } as Window;
}
