import { bookingEngine } from './client'

function getSessionId(): string {
  if (typeof window === 'undefined') return ''
  let sid = sessionStorage.getItem('vayada_sid')
  if (!sid) {
    sid = crypto.randomUUID()
    sessionStorage.setItem('vayada_sid', sid)
  }
  return sid
}

export function trackEvent(hotelSlug: string, eventType: string, metadata?: Record<string, unknown>) {
  if (typeof window === 'undefined' || !hotelSlug) return
  fetch(`${bookingEngine.baseURL}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hotel_slug: hotelSlug,
      event_type: eventType,
      session_id: getSessionId(),
      metadata,
    }),
    keepalive: true,
  }).catch(() => {})
}
