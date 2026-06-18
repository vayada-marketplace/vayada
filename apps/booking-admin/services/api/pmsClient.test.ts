import { afterEach, describe, expect, it, vi } from "vitest";

describe("pmsClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("prefers the legacy compatibility token", async () => {
    const window = createWindowWithStorage();
    vi.stubGlobal("window", window);
    vi.stubGlobal("localStorage", window.localStorage);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer legacy-token");
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const { setAuthKitSession, setLegacyCompatibilityToken } = await import("../auth/sessionStore");
    const { pmsClient } = await import("./pmsClient");

    setAuthKitSession({
      accessToken: "authkit-token",
      user: { id: "user_1", email: "owner@example.com", status: "active" },
    });
    setLegacyCompatibilityToken("legacy-token", 900);

    await expect(pmsClient.get("/admin/hotel")).resolves.toEqual({ ok: true });
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
