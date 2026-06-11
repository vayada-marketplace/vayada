import { bookingWebPublic } from "./client";
import { getBookingWebSessionId } from "./session";

export function trackEvent(
  hotelSlug: string,
  eventType: string,
  metadata?: Record<string, unknown>,
) {
  if (typeof window === "undefined" || !hotelSlug) return;
  fetch(`${bookingWebPublic.baseURL}/api/booking-web/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hotelSlug,
      eventType,
      sessionId: getBookingWebSessionId(),
      metadata,
    }),
    keepalive: true,
  }).catch(() => {});
}
