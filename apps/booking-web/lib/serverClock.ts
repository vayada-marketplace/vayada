/**
 * The server's clock as this page last observed it (VAY-2134). Guests' device clocks can be off
 * by a fraction of a second or by minutes; comparing server timestamps with `Date.now()` made a
 * fresh quote look issued in the future, or already expired, and blocked booking. Fresh server
 * timestamps (a newly issued quote, a guest-rules check) calibrate the offset; quote expiry is
 * then judged against the estimated server time. The server still decides at booking.
 */
let offsetMs: number | null = null;

/** Records a timestamp the server wrote just before responding. It predates the response's
 * arrival by the network latency, so every observation underestimates the offset; the largest
 * one is the closest and a late or replayed answer can't pull the estimate back. If the device
 * clock is corrected forward mid-session, prices look expired until the page reloads. */
export function observeServerTime(serverInstant: string, receivedAt = Date.now()): void {
  const observed = Date.parse(serverInstant) - receivedAt;
  if (!Number.isFinite(observed)) return;
  if (offsetMs === null || observed > offsetMs) offsetMs = observed;
}

/** The estimated server time now, in epoch milliseconds. */
export function serverNow(): number {
  return Date.now() + (offsetMs ?? 0);
}

/** A server instant converted to this device's clock, for timers and device-side storage. */
export function deviceTimeOf(serverInstant: string): number {
  return Date.parse(serverInstant) - (offsetMs ?? 0);
}

/** Forgets the observed offset (tests). */
export function resetServerClock(): void {
  offsetMs = null;
}
