import { describe, expect, it } from "vitest";

import {
  coveredMapInsets,
  MIN_PIN_ZOOM,
  mapClickResult,
  visibleMapPadding,
} from "./GoogleAddressMap";

describe("mapClickResult", () => {
  const spot = { lat: 48.1374, lng: 11.5754 };

  it("zooms in on the clicked spot while the map is too far out for a pin", () => {
    expect(mapClickResult(spot, 2)).toEqual({ action: "zoom", center: spot, zoom: 6 });
    expect(mapClickResult(spot, 12)).toEqual({ action: "zoom", center: spot, zoom: MIN_PIN_ZOOM });
  });

  it("places the pin at street level and zooms close enough to check it", () => {
    expect(mapClickResult(spot, MIN_PIN_ZOOM)).toEqual({ action: "pin", position: spot, zoom: 17 });
    expect(mapClickResult(spot, 19)).toEqual({ action: "pin", position: spot, zoom: 19 });
  });
});

describe("coveredMapInsets", () => {
  const map = { top: 0, bottom: 844 };

  it("counts a card in the upper half as covering the map from the top", () => {
    expect(coveredMapInsets(map, { top: 12, bottom: 523.6 })).toEqual({ top: 524, bottom: 0 });
  });

  it("counts a card in the lower half as covering the map from the bottom", () => {
    expect(coveredMapInsets(map, { top: 320.2, bottom: 832 })).toEqual({ top: 0, bottom: 524 });
  });
});

describe("visibleMapPadding", () => {
  it("keeps the whole pin, drawn above its point, clear of the covered edge", () => {
    expect(visibleMapPadding({ top: 524, bottom: 0 })).toEqual({
      top: 579,
      right: 12,
      bottom: 12,
      left: 12,
    });
    expect(visibleMapPadding({ top: 0, bottom: 524 })).toEqual({
      top: 55,
      right: 12,
      bottom: 536,
      left: 12,
    });
  });
});
