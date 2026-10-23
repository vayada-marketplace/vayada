import { describe, expect, it } from "vitest";

import {
  formatCoordinate,
  parseCoordinate,
  parseCoordinatePair,
  readCoordinates,
  roundCoordinate,
} from "./roomLocation";

describe("room location coordinates", () => {
  it("accepts a comma or a dot and keeps a dot", () => {
    expect(parseCoordinate("6,02957", "latitude")).toEqual({ kind: "value", value: 6.02957 });
    expect(parseCoordinate(" 6.02957 ", "latitude")).toEqual({ kind: "value", value: 6.02957 });
    expect(parseCoordinate("−8,670458", "latitude")).toEqual({ kind: "value", value: -8.670458 });
    expect(parseCoordinate("80,26853°", "longitude")).toEqual({ kind: "value", value: 80.26853 });
    expect(formatCoordinate(6.02957)).toBe("6.02957");
  });

  it("tells an empty, a malformed and an out-of-range value apart", () => {
    expect(parseCoordinate("  ", "latitude")).toEqual({ kind: "empty" });
    expect(parseCoordinate("6,029,57", "latitude")).toEqual({ kind: "invalid" });
    expect(parseCoordinate("abc", "longitude")).toEqual({ kind: "invalid" });
    expect(parseCoordinate("90.5", "latitude")).toEqual({ kind: "out_of_range" });
    expect(parseCoordinate("181,2", "longitude")).toEqual({ kind: "out_of_range" });
    expect(parseCoordinate("-180", "longitude")).toEqual({ kind: "value", value: -180 });
  });

  it("reads a pasted pair from Google Maps or with comma decimals", () => {
    expect(parseCoordinatePair("48.15634, 11.58242")).toEqual({
      latitude: 48.15634,
      longitude: 11.58242,
    });
    expect(parseCoordinatePair("48.15634 11.58242")).toEqual({
      latitude: 48.15634,
      longitude: 11.58242,
    });
    expect(parseCoordinatePair("48,15634; 11,58242")).toEqual({
      latitude: 48.15634,
      longitude: 11.58242,
    });
    expect(parseCoordinatePair("48.15634,11.58242")).toEqual({
      latitude: 48.15634,
      longitude: 11.58242,
    });
    expect(parseCoordinatePair("48,15634 11,58242")).toEqual({
      latitude: 48.15634,
      longitude: 11.58242,
    });
    expect(parseCoordinatePair("48,15634")).toBeNull();
    expect(parseCoordinatePair("48,15")).toBeNull();
    expect(parseCoordinatePair("48.1, 200")).toBeNull();
    expect(parseCoordinatePair("Leopoldstraße 12, Munich")).toBeNull();
  });

  it("needs both values or neither", () => {
    expect(readCoordinates("", "")).toEqual({ ok: true, latitude: null, longitude: null });
    expect(readCoordinates("48,1", "11.5")).toEqual({ ok: true, latitude: 48.1, longitude: 11.5 });
    expect(readCoordinates("48.1", "")).toEqual({ ok: false, error: "coordinatesPair" });
    expect(readCoordinates("x", "11.5")).toEqual({ ok: false, error: "latitudeInvalid" });
    expect(readCoordinates("48.1", "181")).toEqual({ ok: false, error: "longitudeRange" });
  });

  it("rounds a dragged pin to six decimals", () => {
    expect(roundCoordinate(48.156341234567)).toBe(48.156341);
    expect(formatCoordinate(11.58242000000001)).toBe("11.58242");
    expect(formatCoordinate(null)).toBe("");
  });
});
