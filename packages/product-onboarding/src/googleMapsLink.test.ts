import { describe, expect, it } from "vitest";

import { isGoogleMapsShortLink, parseGoogleMapsLink } from "./googleMapsLink";

describe("parseGoogleMapsLink (VAY-2321, VAY-2444)", () => {
  it("reads the pin from a long Google Maps link, and knows a short one has none", () => {
    expect(
      parseGoogleMapsLink(
        "https://www.google.com/maps/place/Leopoldstra%C3%9Fe+12/@48.1561,11.5801,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d48.15634!4d11.58242",
      ),
    ).toEqual({ latitude: 48.15634, longitude: 11.58242 });
    expect(parseGoogleMapsLink("https://www.google.com/maps/@-8.670458,115.212629,15z")).toEqual({
      latitude: -8.670458,
      longitude: 115.212629,
    });
    expect(parseGoogleMapsLink("https://maps.google.com/?q=6.02957,80.26853")).toEqual({
      latitude: 6.02957,
      longitude: 80.26853,
    });
    expect(parseGoogleMapsLink("https://maps.app.goo.gl/AbCdEf123")).toBe("short_link");
    expect(parseGoogleMapsLink("https://www.google.com/maps/@95.1,11.5,15z")).toBeNull();
    expect(parseGoogleMapsLink("https://example.com/@48.1,11.5")).toBeNull();
  });

  it("reads a dropped pin's link and rounds to six decimals", () => {
    expect(
      parseGoogleMapsLink(
        "https://www.google.com/maps/place/5%C2%B057'19.9%22N+80%C2%B042'40.1%22E/@5.9555278,80.7111389,17z/data=!3m1!4b1!4m4!3m3!8m2!3d5.9555278!4d80.7111389",
      ),
    ).toEqual({ latitude: 5.955528, longitude: 80.711139 });
    expect(
      parseGoogleMapsLink("https://www.google.com/maps/search/?api=1&query=5.95553,80.71114"),
    ).toEqual({ latitude: 5.95553, longitude: 80.71114 });
  });

  it("tells short share links apart", () => {
    expect(isGoogleMapsShortLink(" https://maps.app.goo.gl/xyz ")).toBe(true);
    expect(isGoogleMapsShortLink("goo.gl/maps/xyz")).toBe(true);
    expect(isGoogleMapsShortLink("https://www.google.com/maps/@1,2,3z")).toBe(false);
  });
});
