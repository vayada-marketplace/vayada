import { afterEach, describe, expect, it, vi } from "vitest";

describe("settingsService", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("uses the legacy booking API and compatibility token for setup hotel creation", async () => {
    vi.stubEnv("NEXT_PUBLIC_LEGACY_BOOKING_API_URL", "https://api.vayada.com");
    const window = createWindowWithStorage();
    vi.stubGlobal("window", window);
    vi.stubGlobal("localStorage", window.localStorage);

    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.vayada.com/admin/hotels");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer legacy-token");
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({
          id: "booking_hotel_created",
          slug: "created-hotel",
          property_name: "Created Hotel",
          reservation_email: "owner@example.com",
          phone_number: "",
          whatsapp_number: "",
          address: "",
          supported_currencies: ["EUR"],
          supported_languages: ["en"],
          check_in_time: "15:00",
          check_out_time: "11:00",
          pay_at_property_enabled: true,
          pay_at_hotel_methods: [],
          free_cancellation_days: 7,
          email_notifications: true,
          new_booking_alerts: true,
          payment_alerts: true,
          ota_booking_alerts: true,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetch);

    const { setAuthKitSession, setLegacyCompatibilityToken } = await import("../auth/sessionStore");
    const { settingsService } = await import("./index");

    setAuthKitSession({
      accessToken: "authkit-token",
      user: { id: "user_1", email: "owner@example.com", status: "active" },
    });
    setLegacyCompatibilityToken("legacy-token", 900);

    await expect(
      settingsService.createHotel({ property_name: "Created Hotel" }),
    ).resolves.toMatchObject({ id: "booking_hotel_created" });
  });
});

function createWindowWithStorage(): Window {
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string): string | null => storage.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      storage.set(key, value);
    },
    removeItem: (key: string): void => {
      storage.delete(key);
    },
  };

  return { localStorage } as Window;
}
