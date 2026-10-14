import { createBookingPublicationReviewClient } from "@vayada/product-onboarding/bookingPublicationReviewApi";
import { targetApiClient } from "./targetClient";

export type {
  BookingPublicationReview,
  PublicationAttempt,
} from "@vayada/product-onboarding/bookingPublicationReviewApi";

export const bookingPublicationReviewClient = createBookingPublicationReviewClient(targetApiClient);
