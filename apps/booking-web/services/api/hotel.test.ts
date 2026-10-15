/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { hotelService } from "./hotel";

vi.mock("./session", () => ({ getBookingWebSessionId: () => "sid-1" }));

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "referrer");
  window.history.replaceState(null, "", "/");
});

function stubReferrer(referrer: string) {
  Object.defineProperty(document, "referrer", { value: referrer, configurable: true });
}

async function recordedClick() {
  const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
  vi.stubGlobal("fetch", fetch);
  await hotelService.recordAffiliateClick("hotel", "A", "click-1");
  const [, init] = fetch.mock.calls[0] as [string, RequestInit];
  return { init, body: JSON.parse(init.body as string) as Record<string, unknown> };
}

it("sends the referring site but never the page address", async () => {
  window.history.replaceState(
    null,
    "",
    "/en/confirmation?booking=VAY-1&email=guest%40example.test&token=secret&ref=A",
  );
  stubReferrer("https://l.instagram.com/?u=https%3A%2F%2Fhotel.example&e=guest");

  const { init, body } = await recordedClick();

  expect(body).toEqual({
    clickId: "click-1",
    referralCode: "A",
    sessionId: "sid-1",
    referrer: "https://l.instagram.com",
  });
  expect(init.referrerPolicy).toBe("no-referrer");
});

it.each(["", "not a url", "android-app://com.instagram.android/"])(
  "omits a missing or non-web referrer (%s)",
  async (referrer) => {
    stubReferrer(referrer);
    const { body } = await recordedClick();
    expect(body).not.toHaveProperty("referrer");
  },
);
