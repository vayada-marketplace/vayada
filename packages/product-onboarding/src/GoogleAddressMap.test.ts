import { describe, expect, it } from "vitest";

import { MIN_PIN_ZOOM, mapClickResult } from "./GoogleAddressMap";

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
