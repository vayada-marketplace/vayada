import { addressFromGooglePlace, type GooglePlacesAddress } from "./GooglePlacesAddressField";
import { importGoogleMapsLibrary } from "./googleMaps";

type GeocoderComponent = { long_name: string; short_name: string; types: string[] };
type GeocodingLibrary = {
  Geocoder: new () => {
    geocode: (request: { location: { lat: number; lng: number } }) => Promise<{
      results: { address_components?: GeocoderComponent[]; types?: string[] }[];
    }>;
  };
};

// Results Google gives for a spot, most precise first; a building's or street's address beats a town's.
const ADDRESS_TYPES = ["street_address", "premise", "subpremise", "route", "plus_code"];

/** The address Google gives a pin (reverse geocoding, VAY-2444), keeping the pin itself. Null when Google has none
 * or can't be asked (e.g. the Geocoding API is off for the key): the owner then types the address. */
export async function addressFromPin(
  apiKey: string,
  pin: { lat: number; lng: number },
): Promise<GooglePlacesAddress | null> {
  try {
    const { Geocoder } = await importGoogleMapsLibrary<GeocodingLibrary>(apiKey, "geocoding");
    const { results } = await new Geocoder().geocode({ location: pin });
    const withParts = results.filter((result) => result.address_components?.length);
    const best =
      withParts.find((result) => result.types?.some((type) => ADDRESS_TYPES.includes(type))) ??
      withParts[0];
    if (!best) return null;
    const address = addressFromGooglePlace({
      addressComponents: best.address_components!.map((component) => ({
        longText: component.long_name,
        shortText: component.short_name,
        types: component.types,
      })),
    });
    return {
      ...address,
      latitude: pin.lat,
      longitude: pin.lng,
      location: { latitude: pin.lat, longitude: pin.lng },
    };
  } catch {
    return null;
  }
}
