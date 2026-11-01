import { describe, expect, it, vi } from "vitest";

import {
  createShortLinkRateLimit,
  googleMapsLink,
  googleMapsShortLink,
  resolveGoogleMapsShortLink,
} from "./googleMapsShortLinks.js";

const LONG =
  "https://www.google.com/maps/place/42.578496,1.895566/data=!4m6!3m5!1s0!7e2!8m2!3d42.5784957!4d1.8955661?utm_source=mstt_1&entry=gps";

/** A fake fetch: answers each requested URL from the map and records what was asked. */
function fakeFetch(answers: Record<string, { status: number; location?: string } | Error>) {
  const requested: string[] = [];
  const cancelled: string[] = [];
  const request = vi.fn(async (input: URL, init: RequestInit) => {
    requested.push(input.href);
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const answer = answers[input.href];
    if (!answer) throw new Error(`unexpected fetch ${input.href}`);
    if (answer instanceof Error) throw answer;
    const body = new ReadableStream({
      cancel: () => {
        cancelled.push(input.href);
      },
    });
    return new Response(body, {
      status: answer.status,
      headers: answer.location ? { location: answer.location } : {},
    });
  });
  return { request, requested, cancelled };
}

describe("Google Maps short links (VAY-2444)", () => {
  it("accepts only maps.app.goo.gl/<code> and goo.gl/maps/<code>, normalised to https", () => {
    expect(googleMapsShortLink("https://maps.app.goo.gl/Q6ZugPBVWvuiVb8e8")?.href).toBe(
      "https://maps.app.goo.gl/Q6ZugPBVWvuiVb8e8",
    );
    expect(googleMapsShortLink(" maps.app.goo.gl/abc?g_st=iw ")?.href).toBe(
      "https://maps.app.goo.gl/abc?g_st=iw",
    );
    expect(googleMapsShortLink("http://goo.gl/maps/xyz#here")?.href).toBe(
      "https://goo.gl/maps/xyz",
    );
    for (const refused of [
      "https://goo.gl/xyz",
      "https://maps.app.goo.gl/",
      "https://maps.app.goo.gl/a/b",
      "https://maps.app.goo.gl:8443/abc",
      "https://user:pass@maps.app.goo.gl/abc",
      "https://maps.app.goo.gl.evil.test/abc",
      "https://evil.test/maps.app.goo.gl/abc",
      "ftp://maps.app.goo.gl/abc",
      "https://www.google.com/maps/@1,2,3z",
      `https://maps.app.goo.gl/${"a".repeat(65)}`,
      "",
      42,
      null,
    ])
      expect(googleMapsShortLink(refused), String(refused)).toBeNull();
  });

  it("knows a Google Maps link, also behind Google's consent page", () => {
    expect(googleMapsLink(new URL(LONG))?.href).toBe(LONG);
    expect(googleMapsLink(new URL("https://maps.google.com/?q=6.03,80.21"))).not.toBeNull();
    expect(googleMapsLink(new URL("https://google.com/maps/@51.5,-0.1,12z"))).not.toBeNull();
    expect(
      googleMapsLink(
        new URL(`https://consent.google.com/ml?continue=${encodeURIComponent(LONG)}&gl=DE`),
      )?.href,
    ).toBe(LONG);
    for (const refused of [
      "http://www.google.com/maps/@1,2,3z",
      "https://www.google.com/search?q=maps",
      "https://evil.test/maps/@1,2,3z",
      "https://www.google.com.evil.test/maps/@1,2",
      "https://accounts.google.com/maps",
      "https://consent.google.com/ml?continue=https://evil.test/maps",
      "https://consent.google.com/ml?continue=http://www.google.com/maps/@1,2,3z",
      `https://consent.google.com/ml?continue=${encodeURIComponent("https://maps.app.goo.gl/abc")}`,
      // Country domains and look-alikes Google doesn't own, and non-map pages.
      "https://www.google.co.uk/maps/@51.5,-0.1,12z",
      "https://www.google.xyz/maps/@1,2,3z",
      "https://www.google.com.de/maps/@1,2,3z",
      "https://maps.google.co.de/?q=1,2",
      "https://maps.google.com/url?q=https://evil.test",
      "https://www.google.com/sorry/index",
      "https://xn--ggle-0nda.com/maps/@1,2,3z",
    ])
      expect(googleMapsLink(new URL(refused)), refused).toBeNull();
  });

  it("follows the share link's redirect to the long link, never reading the body", async () => {
    const short = "https://maps.app.goo.gl/Q6ZugPBVWvuiVb8e8";
    const fake = fakeFetch({ [short]: { status: 302, location: LONG } });
    expect(await resolveGoogleMapsShortLink(short, fake.request)).toEqual({ ok: true, url: LONG });
    expect(fake.requested).toEqual([short]);
    expect(fake.cancelled).toEqual([short]);
  });

  it("follows another short link, and reads the target out of the consent page's link", async () => {
    const fake = fakeFetch({
      "https://goo.gl/maps/abc": { status: 301, location: "https://maps.app.goo.gl/def" },
      "https://maps.app.goo.gl/def": {
        status: 302,
        location: `https://consent.google.com/ml?continue=${encodeURIComponent(LONG)}`,
      },
    });
    expect(await resolveGoogleMapsShortLink("goo.gl/maps/abc", fake.request)).toEqual({
      ok: true,
      url: LONG,
    });
    expect(fake.requested).toEqual(["https://goo.gl/maps/abc", "https://maps.app.goo.gl/def"]);
  });

  it("never fetches anything but a short link, and stops after three hops", async () => {
    const elsewhere = fakeFetch({
      "https://maps.app.goo.gl/abc": { status: 302, location: "http://169.254.169.254/latest" },
    });
    expect(
      await resolveGoogleMapsShortLink("https://maps.app.goo.gl/abc", elsewhere.request),
    ).toEqual({ ok: false, code: "unresolved" });
    expect(elsewhere.requested).toEqual(["https://maps.app.goo.gl/abc"]);

    const loop = fakeFetch({
      "https://maps.app.goo.gl/a": { status: 302, location: "https://maps.app.goo.gl/b" },
      "https://maps.app.goo.gl/b": { status: 302, location: "https://maps.app.goo.gl/c" },
      "https://maps.app.goo.gl/c": { status: 302, location: "https://maps.app.goo.gl/d" },
    });
    expect(await resolveGoogleMapsShortLink("https://maps.app.goo.gl/a", loop.request)).toEqual({
      ok: false,
      code: "unresolved",
    });
    expect(loop.requested).toHaveLength(3);
  });

  it("follows a relative redirect back to a short link, but never one that leaves it", async () => {
    const relative = fakeFetch({
      "https://maps.app.goo.gl/a": { status: 302, location: "/b" },
      "https://maps.app.goo.gl/b": { status: 302, location: LONG },
    });
    expect(await resolveGoogleMapsShortLink("https://maps.app.goo.gl/a", relative.request)).toEqual(
      { ok: true, url: LONG },
    );
    for (const location of [
      "//evil.test/maps/@1,2,3z",
      "https://maps.app.goo.gl@evil.test/x",
      "https://maps.app.goo.gl\\@evil.test/x",
      "https://maps.app.goo.gl./abc",
      "https://142.250.0.1/maps/@1,2,3z",
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "http://maps.app.goo.gl:443/abc",
    ]) {
      const fake = fakeFetch({ "https://maps.app.goo.gl/a": { status: 302, location } });
      const result = await resolveGoogleMapsShortLink("https://maps.app.goo.gl/a", fake.request);
      expect(result, location).toEqual({ ok: false, code: "unresolved" });
      expect(fake.requested, location).toEqual(["https://maps.app.goo.gl/a"]);
    }
  });

  it("only reads a redirect's Location, and tells Google refusing us apart", async () => {
    const okWithLocation = fakeFetch({
      "https://maps.app.goo.gl/a": { status: 200, location: LONG },
    });
    expect(
      await resolveGoogleMapsShortLink("https://maps.app.goo.gl/a", okWithLocation.request),
    ).toEqual({ ok: false, code: "unresolved" });
    const noLocation = fakeFetch({ "https://maps.app.goo.gl/a": { status: 302 } });
    expect(
      await resolveGoogleMapsShortLink("https://maps.app.goo.gl/a", noLocation.request),
    ).toEqual({ ok: false, code: "unresolved" });
    for (const answer of [
      { status: 429 },
      { status: 503 },
      { status: 302, location: "https://www.google.com/sorry/index?continue=x" },
    ]) {
      const fake = fakeFetch({ "https://maps.app.goo.gl/a": answer });
      expect(
        await resolveGoogleMapsShortLink("https://maps.app.goo.gl/a", fake.request),
        JSON.stringify(answer),
      ).toEqual({ ok: false, code: "unavailable" });
    }
  });

  it("says why a link didn't resolve", async () => {
    const request = vi.fn();
    expect(await resolveGoogleMapsShortLink("https://evil.test/x", request)).toEqual({
      ok: false,
      code: "not_a_short_link",
    });
    expect(request).not.toHaveBeenCalled();
    const page = fakeFetch({ "https://maps.app.goo.gl/abc": { status: 200 } });
    expect(await resolveGoogleMapsShortLink("https://maps.app.goo.gl/abc", page.request)).toEqual({
      ok: false,
      code: "unresolved",
    });
    const down = fakeFetch({ "https://maps.app.goo.gl/abc": new Error("timeout") });
    expect(await resolveGoogleMapsShortLink("https://maps.app.goo.gl/abc", down.request)).toEqual({
      ok: false,
      code: "unavailable",
    });
  });

  it("allows 20 resolutions a minute per person", () => {
    let now = 0;
    const limit = createShortLinkRateLimit({ now: () => now });
    for (let i = 0; i < 20; i += 1) expect(limit("a")).toEqual({ allowed: true });
    expect(limit("a")).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(limit("b")).toEqual({ allowed: true });
    now = 60_000;
    expect(limit("a")).toEqual({ allowed: true });
  });
});
