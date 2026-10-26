import { createHotelSetupChecklistClient } from "@vayada/product-onboarding/hotelSetupChecklistApi";

import { sharedSetupClient } from "./sharedHotelSetupClient";

/** VAY-2247 wave 2: the setup checklist, from the same API as hotel setup. */
export const hotelSetupChecklistApi = createHotelSetupChecklistClient(sharedSetupClient);
