import type { BrowserContext, Page } from "@playwright/test";

/** A made-up address Google's autocomplete suggests for a typed prefix. */
export type FakeGooglePlace = {
  placeId: string;
  mainText: string;
  secondaryText: string;
  formattedAddress: string;
  latitude: number;
  longitude: number;
  /** The district or town Google names it in (VAY-2321's area name for an "Approximate area"). */
  area?: string;
};

export type FakeGoogleMapsOptions = {
  places?: FakeGooglePlace[];
  /** The script loads, then Google rejects the key through `gm_authFailure`. */
  authFailure?: boolean;
  /** Autocomplete requests fail (Places API off for the key). */
  placesUnavailable?: boolean;
};

export const GOOGLE_MAPS_SCRIPT = /https:\/\/maps\.googleapis\.com\/maps\/api\/js/;

/**
 * The parts of the Google Maps JavaScript API the PMS room location field uses (VAY-2126, VAY-2321): a map, a
 * draggable marker, a fixed reference marker, an area circle, and Places autocomplete with session tokens. The map
 * canvas keeps what Google would draw in data attributes: `data-marker` is the pin (`data-marker-visible` "false"
 * when hidden), `data-reference` the reference pin, `data-circle` an area ("lat,lng,radius"), `data-map-type`
 * the map type, `data-center`/`data-zoom` the camera. `element.vayadaE2eDragMarker(lat, lng)` drags the pin and
 * `element.vayadaE2eClickMap(lat, lng)` clicks the map. `window.vayadaE2ePlaceQueries` keeps every autocomplete
 * input and fetched field list.
 */
export function googleMapsFakeScript({
  places = [],
  authFailure = false,
  placesUnavailable = false,
}: FakeGoogleMapsOptions = {}) {
  return `
    const places = ${JSON.stringify(places)};
    const latLng = (lat, lng) => ({ lat: () => lat, lng: () => lng });
    window.vayadaE2ePlaceQueries = [];
    class GoogleMap {
      constructor(element, options) {
        this.element = element;
        this.listeners = {};
        this.setCenter(options.center);
        this.setZoom(options.zoom);
        element.vayadaE2eClickMap = (lat, lng) => this.listeners.click?.({ latLng: latLng(lat, lng) });
        if (${authFailure}) setTimeout(() => window.gm_authFailure?.(), 0);
      }
      addListener(eventName, handler) {
        this.listeners[eventName] = handler;
        return { remove: () => delete this.listeners[eventName] };
      }
      getZoom() { return this.zoom; }
      moveCamera({ center, zoom }) { this.setCenter(center); this.setZoom(zoom); }
      panToBounds() {}
      setCenter(position) { this.element.dataset.center = position.lat + "," + position.lng; }
      setZoom(zoom) { this.zoom = zoom; this.element.dataset.zoom = String(zoom); }
      setMapTypeId(mapTypeId) { this.element.dataset.mapType = mapTypeId; }
    }
    class GoogleCircle {
      constructor(options) { this.element = options.map.element; this.radius = options.radius; this.setVisible(options.visible); }
      setCenter(center) { this.center = center; this.draw(); }
      setVisible(visible) { this.visible = visible; this.draw(); }
      draw() {
        if (this.visible && this.center) this.element.dataset.circle = this.center.lat + "," + this.center.lng + "," + this.radius;
        else delete this.element.dataset.circle;
      }
    }
    class GoogleMarker {
      constructor(options) {
        this.element = options.map.element;
        this.listeners = {};
        // A marker with its own icon is the fixed reference pin, kept apart from the main pin.
        this.attribute = options.icon ? "reference" : "marker";
        if (options.icon) {
          this.setTitle(options.title);
          this.setPosition(options.position);
          return;
        }
        this.element.dataset.markerDraggable = String(Boolean(options.draggable));
        this.element.dataset.markerTitle = options.title;
        this.element.vayadaE2eDragMarker = (lat, lng) => {
          this.setPosition({ lat, lng });
          this.listeners.dragend?.({ latLng: latLng(lat, lng) });
        };
        this.setPosition(options.position);
      }
      addListener(eventName, handler) { this.listeners[eventName] = handler; }
      setPosition(position) {
        if (position) this.element.dataset[this.attribute] = position.lat + "," + position.lng;
        else delete this.element.dataset[this.attribute];
      }
      setTitle(title) { if (this.attribute === "reference") this.element.dataset.referenceTitle = title; }
      setVisible(visible) { this.element.dataset[this.attribute + "Visible"] = String(visible); }
    }
    class AutocompleteSessionToken {}
    const AutocompleteSuggestion = {
      fetchAutocompleteSuggestions: async ({ input, sessionToken }) => {
        window.vayadaE2ePlaceQueries.push("suggest:" + input + (sessionToken instanceof AutocompleteSessionToken ? "" : ":no-session"));
        if (${placesUnavailable}) throw new Error("Places API is not enabled for this key.");
        const query = input.trim().toLowerCase();
        return {
          suggestions: places
            .filter((place) => (place.mainText + " " + place.secondaryText).toLowerCase().startsWith(query))
            .map((place) => ({
              placePrediction: {
                placeId: place.placeId,
                text: { text: place.mainText + ", " + place.secondaryText },
                mainText: { text: place.mainText },
                secondaryText: { text: place.secondaryText },
                toPlace: () => {
                  const result = {
                    fetchFields: async ({ fields }) => {
                      window.vayadaE2ePlaceQueries.push("fields:" + place.placeId + ":" + fields.join(","));
                      result.formattedAddress = place.formattedAddress;
                      result.location = latLng(place.latitude, place.longitude);
                      result.addressComponents = place.area
                        ? [{ longText: place.area, shortText: place.area, types: ["sublocality_level_1", "sublocality", "political"] }]
                        : [];
                    },
                  };
                  return result;
                },
              },
            })),
        };
      },
    };
    window.google = {
      maps: {
        importLibrary: async (library) =>
          library === "maps" ? { Map: GoogleMap, Circle: GoogleCircle }
          : library === "marker" ? { Marker: GoogleMarker }
          : library === "core" ? { ControlPosition: { RIGHT_TOP: 3 } }
          : library === "places" ? { AutocompleteSessionToken, AutocompleteSuggestion }
          : Promise.reject(new Error("Unknown library " + library)),
      },
    };
    window.__vayadaGoogleMapsReady?.();
  `;
}

/** Answers the Maps script with the fake, for one page (a spec's own route) or a whole context (a default). */
export async function mockGoogleMaps(
  target: Page | BrowserContext,
  options: FakeGoogleMapsOptions = {},
) {
  await target.route(GOOGLE_MAPS_SCRIPT, (route) =>
    route.fulfill({ contentType: "application/javascript", body: googleMapsFakeScript(options) }),
  );
}
