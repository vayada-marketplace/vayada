/**
 * The server's clock as this page last observed it (VAY-2134). Guests' device clocks can be off
 * by a fraction of a second or by minutes; comparing server timestamps with `Date.now()` made a
 * fresh quote look issued in the future, or already expired, and blocked booking. Fresh server
 * timestamps (a newly issued quote, a guest-rules check) calibrate the offset; quote expiry is
 * then judged against the estimated server time. The server still decides at booking.
 */
let offsetMs: number | null = null;
let restored = false;

/** Kept for the tab, so a reload judges a replayed quote on the same clock; an estimate older than
 * a few quote lifetimes is not restored. */
const STORAGE_KEY = "vayada:booking:server-clock:v1";
const RESTORE_WITHIN_MS = 15 * 60_000;

function tabStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function currentOffset(): number | null {
  if (!restored) {
    restored = true;
    try {
      const saved: unknown = JSON.parse(tabStorage()?.getItem(STORAGE_KEY) ?? "null");
      if (
        offsetMs === null &&
        saved &&
        typeof saved === "object" &&
        "offsetMs" in saved &&
        "savedAt" in saved &&
        typeof saved.offsetMs === "number" &&
        typeof saved.savedAt === "number" &&
        Number.isFinite(saved.offsetMs) &&
        Math.abs(Date.now() - saved.savedAt) <= RESTORE_WITHIN_MS
      )
        offsetMs = saved.offsetMs;
    } catch {
      // Unavailable or malformed storage: start from the device clock.
    }
  }
  return offsetMs;
}

/** Records a timestamp the server wrote just before responding. It predates the response's
 * arrival by the network latency, so every observation underestimates the offset; the largest
 * one is the closest and a late or replayed answer can't pull the estimate back. If the device
 * clock is corrected forward mid-session, prices look expired until the page is reopened later. */
export function observeServerTime(serverInstant: string, receivedAt = Date.now()): void {
  const observed = Date.parse(serverInstant) - receivedAt;
  if (!Number.isFinite(observed)) return;
  const prior = currentOffset();
  if (prior !== null && observed <= prior) return;
  offsetMs = observed;
  try {
    tabStorage()?.setItem(STORAGE_KEY, JSON.stringify({ offsetMs: observed, savedAt: receivedAt }));
  } catch {
    // The estimate still holds for this page.
  }
}

/** The estimated server time now, in epoch milliseconds. */
export function serverNow(): number {
  return Date.now() + (currentOffset() ?? 0);
}

/** A server instant converted to this device's clock, for timers and device-side storage. */
export function deviceTimeOf(serverInstant: string): number {
  return Date.parse(serverInstant) - (currentOffset() ?? 0);
}

/** Forgets the in-memory offset, as a reload does (tests). */
export function resetServerClock(): void {
  offsetMs = null;
  restored = false;
}
