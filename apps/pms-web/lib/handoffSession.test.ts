import { afterEach, beforeEach, expect, it, vi } from "vitest";
import HandoffPage from "../app/handoff/page";

vi.mock("react", () => ({ useEffect: (effect: () => void) => effect() }));

let values: Map<string, string>;
let location: { hash: string; search: string; href: string };

beforeEach(() => {
  values = new Map([
    ["selectedHotelId", "previous-hotel"],
    ["pmsSetupComplete", "true"],
  ]);
  location = { hash: "#token=new-token&expires_at=9999999999999", search: "", href: "" };
  vi.stubGlobal("window", { location });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});

afterEach(() => vi.unstubAllGlobals());

it("discards the previous hotel before accepting an explicit redirect", async () => {
  location.search = "?redirect=/dashboard";
  const fetch = vi.fn().mockResolvedValue(Response.json({ setup_complete: true }));
  vi.stubGlobal("fetch", fetch);
  HandoffPage();
  await vi.waitFor(() => expect(location.href).toBe("/dashboard"));
  expect(values.has("selectedHotelId")).toBe(false);
  expect(fetch.mock.calls[0][1].headers["X-Hotel-Id"]).toBeUndefined();
});

it("uses an explicitly supplied handoff hotel", async () => {
  location.hash += "&hotel_id=current-hotel";
  const fetch = vi.fn().mockResolvedValue(Response.json({ setup_complete: true }));
  vi.stubGlobal("fetch", fetch);
  HandoffPage();
  await vi.waitFor(() => expect(location.href).toBe("/dashboard"));
  expect(values.get("selectedHotelId")).toBe("current-hotel");
  expect(fetch.mock.calls[0][1].headers["X-Hotel-Id"]).toBe("current-hotel");
});

it.each(["http", "network"])(
  "returns to login on a %s failure despite redirect",
  async (failure) => {
    location.search = "?redirect=/setup";
    const fetch = vi.fn();
    if (failure === "http") fetch.mockResolvedValue(new Response(null, { status: 403 }));
    else fetch.mockRejectedValue(new Error("Network unavailable"));
    vi.stubGlobal("fetch", fetch);
    HandoffPage();
    await vi.waitFor(() => expect(location.href).toBe("/login"));
    expect(values.has("selectedHotelId")).toBe(false);
    expect(values.has("pmsSetupComplete")).toBe(false);
  },
);
