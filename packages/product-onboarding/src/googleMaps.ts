type GoogleMapsWindow = Window & {
  google?: {
    maps?: {
      importLibrary?: (library: string) => Promise<unknown>;
    };
  };
  __vayadaGoogleMapsReady?: () => void;
};

let googleMapsScriptPromise: Promise<void> | null = null;

export async function importGoogleMapsLibrary<Library>(
  apiKey: string,
  library: string,
): Promise<Library> {
  const googleWindow = window as GoogleMapsWindow;
  const existingImportLibrary = googleWindow.google?.maps?.importLibrary;
  if (existingImportLibrary) return existingImportLibrary(library) as Promise<Library>;

  if (!googleMapsScriptPromise) {
    googleMapsScriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      const url = new URL("https://maps.googleapis.com/maps/api/js");
      url.search = new URLSearchParams({
        key: apiKey,
        v: "weekly",
        loading: "async",
        language: "en",
        auth_referrer_policy: "origin",
        callback: "__vayadaGoogleMapsReady",
      }).toString();

      googleWindow.__vayadaGoogleMapsReady = () => {
        delete googleWindow.__vayadaGoogleMapsReady;
        resolve();
      };
      script.src = url.toString();
      script.async = true;
      script.dataset.vayadaGoogleMaps = "true";
      script.onerror = () => {
        delete googleWindow.__vayadaGoogleMapsReady;
        script.remove();
        reject(new Error("Google Maps could not load."));
      };
      document.head.appendChild(script);
    }).catch((error) => {
      googleMapsScriptPromise = null;
      throw error;
    });
  }

  await googleMapsScriptPromise;
  const importLibrary = googleWindow.google?.maps?.importLibrary;
  if (!importLibrary) throw new Error("Google Maps is unavailable.");
  return importLibrary(library) as Promise<Library>;
}

type GooglePlacesTextSearchLibrary = {
  Place: {
    searchByText: (request: {
      textQuery: string;
      fields: string[];
      maxResultCount: number;
    }) => Promise<{
      places: { location?: { lat: () => number; lng: () => number } | null; types?: string[] }[];
    }>;
  };
};

// Result types that point at one building; anything else (a street, postcode, town) is an area.
const PRECISE_PLACE_TYPES = [
  "street_address",
  "premise",
  "subpremise",
  "establishment",
  "point_of_interest",
  "lodging",
];

/** Looks up a typed address with Places text search; null when Google finds nothing. */
export async function findAddressOnMap(
  apiKey: string,
  address: string,
): Promise<{ position: { lat: number; lng: number }; precise: boolean } | null> {
  const { Place } = await importGoogleMapsLibrary<GooglePlacesTextSearchLibrary>(apiKey, "places");
  const { places } = await Place.searchByText({
    textQuery: address,
    fields: ["location", "types"],
    maxResultCount: 1,
  });
  const place = places[0];
  if (!place?.location) return null;
  return {
    position: { lat: place.location.lat(), lng: place.location.lng() },
    precise: (place.types ?? []).some((type) => PRECISE_PLACE_TYPES.includes(type)),
  };
}
