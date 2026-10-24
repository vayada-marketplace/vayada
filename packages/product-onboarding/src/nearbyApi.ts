import {
  parseNearbyCurationState,
  parseNearbyCurationWrite,
  type NearbyCurationWrite,
} from "@vayada/domain-hotels";
import type { SharedHotelSetupHttpClient } from "./sharedHotelSetupApi";

/** The location page's nearby places. Google suggestions left the editor in v1 (VAY-2326), so it doesn't call the
 * discovery routes; they return with VAY-2207. */
export function createNearbyApi(client: SharedHotelSetupHttpClient) {
  const path = (id: string) => `/api/hotel-setup/properties/${encodeURIComponent(id)}/nearby`;
  return {
    read: async (id: string, options?: RequestInit) =>
      parseNearbyCurationState(await client.get(`${path(id)}/curation`, options)),
    save: async (id: string, write: NearbyCurationWrite) => {
      const parsed = parseNearbyCurationWrite(write);
      if (!parsed.ok)
        throw new Error("Check the place names, coordinates and notes before saving.");
      return parseNearbyCurationState(await client.put(`${path(id)}/curation`, parsed.value));
    },
  };
}
export type NearbyApi = ReturnType<typeof createNearbyApi>;
