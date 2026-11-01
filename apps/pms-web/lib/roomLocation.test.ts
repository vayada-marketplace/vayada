import { describe, expect, it } from "vitest";

import {
  areaFromAddressComponents,
  formatCoordinate,
  formatDistance,
  metresBetween,
  parseCoordinate,
  parseCoordinatePair,
  readCoordinates,
  roomLocationSource,
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

describe("room location display (VAY-2321)", () => {
  it("measures the distance to the property and shows it in metres or kilometres", () => {
    const property = { latitude: 48.1394, longitude: 11.5835 };
    expect(metresBetween(property, { latitude: 48.15634, longitude: 11.58242 })).toBeCloseTo(
      1890,
      -2,
    );
    expect(formatDistance(1886, "en")).toBe("1.9 km");
    expect(formatDistance(1886, "de")).toBe("1,9 km");
    expect(formatDistance(344, "en")).toBe("340 m");
    expect(formatDistance(2, "en")).toBe("10 m");
  });

  it("reads a room saved before VAY-2321 as guests are shown it", () => {
    const property = { latitude: 48.1394, longitude: 11.5835 };
    const room = (latitude: number | null, longitude: number | null) => ({ latitude, longitude });
    expect(roomLocationSource(room(null, null), property)).toBe("property");
    expect(roomLocationSource(room(48.15634, 11.58242), property)).toBe("custom");
    // A pin typed on the hotel's own building is the hotel's place.
    expect(roomLocationSource(room(48.13941, 11.5835), property)).toBe("property");
    expect(roomLocationSource(room(48.13941, 11.5835), null)).toBe("custom");
    expect(roomLocationSource({ ...room(null, null), locationSource: "custom" }, property)).toBe(
      "custom",
    );
  });

  it("names the area Google puts an address in", () => {
    expect(
      areaFromAddressComponents([
        { longText: "12", types: ["street_number"] },
        { longText: "München", types: ["locality", "political"] },
        { longText: "Schwabing", types: ["sublocality_level_1", "sublocality", "political"] },
      ]),
    ).toBe("Schwabing");
    expect(areaFromAddressComponents([{ longText: "Ahangama", types: ["locality"] }])).toBe(
      "Ahangama",
    );
    expect(areaFromAddressComponents(undefined)).toBe("");
  });
});
