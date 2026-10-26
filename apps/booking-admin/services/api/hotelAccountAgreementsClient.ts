import { createHotelAccountAgreementsClient } from "@vayada/product-onboarding/hotelAccountAgreementsApi";

import { sharedSetupClient } from "./sharedHotelSetupClient";

/** VAY-2246: the hotel account's terms and data processing agreement, from the same API as hotel setup. */
export const hotelAccountAgreementsApi = createHotelAccountAgreementsClient(sharedSetupClient);
