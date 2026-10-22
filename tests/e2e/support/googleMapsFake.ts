import type { BrowserContext, Page } from "@playwright/test";

/** A made-up address Google's autocomplete suggests for a typed prefix. */
export type FakeGooglePlace = {
  placeId: string;
  mainText: string;
  secondaryText: string;
  formattedAddress: string;
  latitude: number;
  longitude: number;
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
 * The parts of the Google Maps JavaScript API the PMS room location field uses (VAY-2126): a map, a draggable
 * marker, and Places autocomplete with session tokens. The map canvas keeps what Google would draw in data
 * attributes: `data-marker` is the pin, `data-center`/`data-zoom` the camera. `element.vayadaE2eDragMarker(lat,
 * lng)` drags the pin. `window.vayadaE2ePlaceQueries` keeps every autocomplete input and fetched field list.
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
    }
    class GoogleMarker {
      constructor(options) {
        this.element = options.map.element;
        this.listeners = {};
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
        if (position) this.element.dataset.marker = position.lat + "," + position.lng;
        else delete this.element.dataset.marker;
      }
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
          library === "maps" ? { Map: GoogleMap }
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
