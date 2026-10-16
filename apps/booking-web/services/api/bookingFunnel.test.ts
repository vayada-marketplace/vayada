import { afterEach, describe, expect, it, vi } from "vitest";
import { BOOKING_WEB_ANALYTICS_CONSENT_VERSION } from "@vayada/domain-booking/conversion-funnel";
import { trackEvent } from "./tracking";
import { analyticsChoice, onAnalyticsAllowed, saveAnalyticsChoice } from "./analyticsConsent";

afterEach(() => vi.unstubAllGlobals());

function mockBrowser(
  choice: unknown = { version: BOOKING_WEB_ANALYTICS_CONSENT_VERSION, analytics: true },
) {
  const storage = new Map<string, string>();
  const local = new Map([["vayada_booking_analytics:hotel", JSON.stringify(choice)]]);
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value),
    removeItem: (key: string) => local.delete(key),
  });
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  return storage;
}

describe("Booking funnel instrumentation", () => {
  it.each([
    null,
    {},
    { version: BOOKING_WEB_ANALYTICS_CONSENT_VERSION, analytics: false },
    // A choice under the earlier consent text (VAY-2213 asks everyone again) or a future one.
    { version: 1, analytics: true },
    { version: BOOKING_WEB_ANALYTICS_CONSENT_VERSION + 1, analytics: true },
    { version: BOOKING_WEB_ANALYTICS_CONSENT_VERSION, analytics: "true" },
  ])("does not allocate identifiers or dispatch without valid consent: %j", (choice) => {
    const storage = mockBrowser(choice);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    trackEvent("hotel", "page_visit", {});
    expect(fetch).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
  });

  it("isolates hotels, clears withdrawal identifiers, and starts a fresh accepted session", () => {
    const storage = mockBrowser();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    trackEvent("hotel", "page_visit", {});
    const first = storage.get("vayada_sid:hotel");
    expect(first).toBeTruthy();
    expect(analyticsChoice("other-hotel")).toBeNull();
    trackEvent("other-hotel", "page_visit", {});
    expect(storage.has("vayada_sid:other-hotel")).toBe(false);
    saveAnalyticsChoice("hotel", false);
    expect(storage.size).toBe(0);
    trackEvent("hotel", "room_viewed", { roomTypeId: "suite" });
    expect(storage.size).toBe(0);
    saveAnalyticsChoice("hotel", true);
    trackEvent("hotel", "page_visit", {});
    expect(storage.get("vayada_sid:hotel")).not.toBe(first);
  });

  it("fails closed when persisting withdrawal fails", () => {
    const storage = mockBrowser();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    trackEvent("hotel", "page_visit", {});
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(saveAnalyticsChoice("hotel", false)).toBe(false);
    expect(analyticsChoice("hotel")).toBe(false);
    expect(storage.size).toBe(0);
    mockBrowser();
    saveAnalyticsChoice("hotel", false);
  });

  it("carries a stable session and increasing sequence without interrupting checkout", () => {
    mockBrowser();
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    trackEvent("hotel", "page_visit", {});
    trackEvent("hotel", "rate_selected", { entry: "room_card" });
    const events = fetch.mock.calls.map((call) =>
      JSON.parse((call as unknown as [string, RequestInit])[1].body as string),
    );
    expect(events.map((event) => event.metadata.funnelSequence)).toEqual([1, 2]);
    expect(events[0].sessionId).toBe(events[1].sessionId);
    expect(events[0].eventId).not.toBe(events[1].eventId);
    vi.stubGlobal("sessionStorage", {
      getItem() {
        throw new Error("disabled");
      },
    });
    expect(() => trackEvent("hotel", "rate_selected", { entry: "room_card" })).not.toThrow();
  });

  it("sends only each event's own properties, without the page address (VAY-2197)", () => {
    mockBrowser();
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    trackEvent("hotel", "booking_error", {
      step: "payment",
      reason: "price_refused",
      code: undefined,
    });
    // A property outside the allowlist (here a guest's email) drops the whole event.
    trackEvent("hotel", "details_completed", { email: "guest@example.com" } as never);
    trackEvent("hotel", "step_viewed", { step: "confirmation" } as never);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(JSON.parse(init.body as string)).toMatchObject({
      eventType: "booking_error",
      metadata: { step: "payment", reason: "price_refused", funnelVersion: 1, funnelSequence: 1 },
    });
    expect(JSON.parse(init.body as string).metadata).not.toHaveProperty("code");
  });

  it("posts straight to the API as text/plain, without cookies or the page address (VAY-2214)", () => {
    mockBrowser({ version: BOOKING_WEB_ANALYTICS_CONSENT_VERSION, analytics: true });
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("NEXT_PUBLIC_BOOKING_WEB_API_URL", "https://next-api.example.test/");
    trackEvent("hotel", "page_visit", {});
    vi.stubEnv("NEXT_PUBLIC_BOOKING_WEB_API_URL", "");
    trackEvent("hotel", "page_visit", {});
    vi.unstubAllEnvs();

    const [[direct, init], [sameOrigin]] = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(direct).toBe("https://next-api.example.test/api/booking-web/events");
    expect(sameOrigin).toBe("/api/booking-web/events");
    expect(init).toMatchObject({
      method: "POST",
      mode: "cors",
      credentials: "omit",
      keepalive: true,
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
    });
    expect(JSON.parse(init.body as string)).toMatchObject({
      analyticsConsent: true,
      consentVersion: BOOKING_WEB_ANALYTICS_CONSENT_VERSION,
      hotelSlug: "hotel",
      eventType: "page_visit",
    });
  });

  it("tells the hotel page when the guest switches analytics on, once", () => {
    mockBrowser(null);
    const events = new EventTarget();
    vi.stubGlobal("window", events);
    const allowed = vi.fn();
    const stop = onAnalyticsAllowed("hotel", allowed);
    onAnalyticsAllowed("other-hotel", () => allowed("other"));
    saveAnalyticsChoice("hotel", true);
    saveAnalyticsChoice("hotel", true);
    expect(allowed).toHaveBeenCalledTimes(1);
    expect(allowed).toHaveBeenCalledWith();
    saveAnalyticsChoice("hotel", false);
    saveAnalyticsChoice("hotel", true);
    expect(allowed).toHaveBeenCalledTimes(2);
    stop();
    saveAnalyticsChoice("hotel", false);
    saveAnalyticsChoice("hotel", true);
    expect(allowed).toHaveBeenCalledTimes(2);
  });
});
