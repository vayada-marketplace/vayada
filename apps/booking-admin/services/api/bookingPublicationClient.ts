import { createBookingPublicationReviewClient } from "@vayada/product-onboarding/bookingPublicationReviewApi";

import { apiClient } from "./client";

/** The same publication review and publish API as the setup "Booking Engine" card (VAY-2187). */
export const bookingPublicationApi = createBookingPublicationReviewClient(apiClient);
