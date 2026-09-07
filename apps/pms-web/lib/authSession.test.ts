import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authService } from "../services/auth";
import { pmsSettingsService } from "../services/settings";

let values: Map<string, string>;

beforeEach(() => {
  values = new Map([
    ["selectedHotelId", "previous-hotel"],
    ["pmsSetupComplete", "true"],
  ]);
  vi.stubGlobal("window", { location: { href: "" } });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});

afterEach(() => vi.unstubAllGlobals());

it("does not send the previous hotel's context after a successful login", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        id: "new-user",
        email: "hotel@example.test",
        name: "Hotel",
        type: "hotel",
        status: "active",
        access_token: "new-token",
        expires_in: 3600,
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        registered: true,
        setupComplete: true,
        roomCount: 1,
      }),
    );
  vi.stubGlobal("fetch", fetch);

  await authService.login({ email: "hotel@example.test", password: "test-only" });
  await pmsSettingsService.getSetupStatus();

  expect(values.has("selectedHotelId")).toBe(false);
  expect(values.has("pmsSetupComplete")).toBe(false);
  expect(fetch.mock.calls[1][1].headers["X-Hotel-Id"]).toBeUndefined();
  expect(fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer new-token");
});

it("clears hotel context when logging out", () => {
  authService.logout();
  expect(values.has("selectedHotelId")).toBe(false);
  expect(values.has("pmsSetupComplete")).toBe(false);
});

it("does not change the existing hotel selection when authentication fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(Response.json({ detail: "Invalid email or password" }, { status: 401 })),
  );
  await expect(
    authService.login({ email: "hotel@example.test", password: "wrong" }),
  ).rejects.toThrow("Invalid email or password");
  expect(values.get("selectedHotelId")).toBe("previous-hotel");
});
