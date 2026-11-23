import { createHostNotificationsClient } from "@vayada/product-onboarding/hostNotifications";
import { pmsOperationsClient, pmsOperationsRequestOptions } from "./pmsOperationsClient";

/** The notifications bell's feed and marks in PMS (VAY-2591): the same API as Booking Admin's bell
 * (`/api/booking/properties/:id/notifications`), through PMS's own next-api client. */
export const pmsNotificationsClient = createHostNotificationsClient({
  get: <T>(endpoint: string, options?: RequestInit) =>
    pmsOperationsClient.get<T>(endpoint, { ...pmsOperationsRequestOptions, ...options }),
  post: <T>(endpoint: string, data?: unknown, options?: RequestInit) =>
    pmsOperationsClient.post<T>(endpoint, data, { ...pmsOperationsRequestOptions, ...options }),
});
