import { createHostNotificationsClient } from "@vayada/product-onboarding/hostNotifications";
import { apiClient } from "./client";

/** The bell's feed and marks (VAY-2349, VAY-2591) through Booking Admin's API client. The client itself is
 * shared with PMS: `@vayada/product-onboarding/hostNotifications`. */
export * from "@vayada/product-onboarding/hostNotifications";
export const bookingNotificationsClient = createHostNotificationsClient(apiClient);
