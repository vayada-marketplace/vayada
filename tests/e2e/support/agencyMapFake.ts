import type { Page } from "@playwright/test";

/**
 * The Google Maps calls the agency page's map makes (VAY-2460), for the GuestMap pills: each pill
 * is a page button an OverlayView puts on the map, here at its spot within a fixed view around
 * Ubud, over a plain background. `window.__agencyMap` counts maps, fits and pans.
 */
const AGENCY_MAP_FAKE = `
  // An IIFE: a top-level "class Map" would replace the browser's own Map for the whole page.
  (() => {
  const state = (window.__agencyMap = { maps: 0, fitted: 0, panned: 0, circles: 0 });
  const view = { north: -8.462, south: -8.534, west: 115.236, east: 115.29 };
  const point = (position) => {
    if (position instanceof LatLng) return { lat: position.lat(), lng: position.lng() };
    if (typeof position?.lat === "number" && typeof position?.lng === "number") return position;
    throw new Error("InvalidValueError: not a LatLng or LatLngLiteral");
  };
  class Map {
    constructor(element, options) {
      state.maps += 1; this.zoom = options.zoom; this.element = element;
      element.style.background = "linear-gradient(160deg, #e7ede2, #dfe7dc 55%, #e9efe6)";
      this.pane = document.createElement("div"); element.append(this.pane);
    }
    fitBounds() { state.fitted += 1; setTimeout(() => this.idle?.(), 0); }
    addListener(event, handler) { if (event === "idle") this.idle = handler; return { remove: () => (this.idle = null) }; }
    getZoom() { return this.zoom; }
    setZoom(zoom) { this.zoom = zoom; }
    getBounds() { return { contains: () => true }; }
    panTo() { state.panned += 1; }
  }
  class OverlayView {
    static preventMapHitsAndGesturesFrom(element) { element.dataset.noMapGestures = "1"; }
    setMap(map) {
      if (!map) return this.onRemove();
      this.map = map; this.onAdd(); this.draw();
    }
    getPanes() { return { floatPane: this.map.pane }; }
    getProjection() {
      const box = this.map.element;
      return { fromLatLngToDivPixel: (position) => ({
        x: ((position.lng() - view.west) / (view.east - view.west)) * box.clientWidth,
        y: ((view.north - position.lat()) / (view.north - view.south)) * box.clientHeight,
      }) };
    }
  }
  class Circle {
    constructor(options) { point(options.center); state.circles += 1; }
    setMap() {}
    setVisible(visible) { this.visible = visible; }
  }
  class LatLng { constructor(lat, lng) { this.lat = () => lat; this.lng = () => lng; } }
  class LatLngBounds { extend(position) { point(position); } }
  window.google = { maps: { importLibrary: async (library) =>
    library === "maps" ? { Map, Circle, OverlayView }
    : library === "core" ? { LatLng, LatLngBounds, ControlPosition: { RIGHT_TOP: 3 } } : {} } };
  window.__vayadaGoogleMapsReady?.();
  })();
`;

/** Answers Google's script with the fake; returns the script requests (none before consent). */
export async function mockAgencyMap(page: Page) {
  const requests: string[] = [];
  await page.route("https://maps.googleapis.com/**", (route) => {
    requests.push(route.request().url());
    return route.fulfill({ contentType: "application/javascript", body: AGENCY_MAP_FAKE });
  });
  return requests;
}
