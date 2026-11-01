import { createMapsLinkApi } from "@vayada/product-onboarding/mapsLinkApi";
import { createNearbyApi } from "@vayada/product-onboarding/nearbyApi";
import { createSharedHotelSetupApi } from "@vayada/product-onboarding";

import { ApiClient } from "./client";

const SHARED_SETUP_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.localhost";
export const sharedSetupClient = new ApiClient(SHARED_SETUP_API_BASE_URL);

export const sharedHotelSetupApi = createSharedHotelSetupApi(sharedSetupClient);

export const nearbyApi = createNearbyApi(sharedSetupClient);
// VAY-2444: maps.app.goo.gl share links, read by the API for onboarding's "Where it is".
export const mapsLinkApi = createMapsLinkApi(sharedSetupClient);
