import {
  FUNNEL_ERROR_CODES,
  parseFunnelEventMetadata,
  type FunnelEventProperties,
  type FunnelEventType,
} from "@vayada/domain-booking/conversion-funnel";
import { bookingWebPublic } from "./client";
import { getBookingWebSessionId } from "./session";

/** One of our own API's refusal codes, or nothing: never free text or a card decline code. */
export function funnelErrorCode(code: unknown) {
  return FUNNEL_ERROR_CODES.find((known) => known === code);
}

/** A funnel event, only with analytics consent and only with the properties its type allows
 * (VAY-2197): an event carrying anything else is never sent. */
export function trackEvent<T extends FunnelEventType>(
  hotelSlug: string,
  eventType: T,
  properties: FunnelEventProperties[T],
) {
  if (typeof window === "undefined" || !hotelSlug) return;
  // Analytics must never interrupt checkout when storage is disabled or full.
  try {
    const metadata: Record<string, unknown> = Object.fromEntries(
      Object.entries(properties).filter(([, value]) => value !== undefined),
    );
    if (!parseFunnelEventMetadata(eventType, { ...metadata, funnelVersion: 1, funnelSequence: 1 }))
      return;
    const sessionId = getBookingWebSessionId(hotelSlug);
    if (!sessionId) return;
    const key = `vayada_funnel_sequence:${sessionId}`;
    const sequence = Number(sessionStorage.getItem(key) || 0) + 1;
    sessionStorage.setItem(key, String(sequence));
    void fetch(`${bookingWebPublic.baseURL}/api/booking-web/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        analyticsConsent: true,
        consentVersion: 1,
        hotelSlug,
        eventType,
        sessionId,
        eventId: crypto.randomUUID(),
        metadata: { ...metadata, funnelVersion: 1, funnelSequence: sequence },
      }),
      keepalive: true,
      // The page's address holds the stay's dates and any promo code.
      referrerPolicy: "no-referrer",
    }).catch(() => {});
  } catch {}
}
