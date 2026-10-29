import { BOOKING_WEB_ANALYTICS_CONSENT_VERSION as VERSION } from "@vayada/domain-booking/conversion-funnel";

const key = (slug: string) => `vayada_booking_analytics:${slug}`;
const denied = new Set<string>();

export function analyticsChoice(slug: string): boolean | null {
  if (!slug || typeof window === "undefined") return null;
  if (denied.has(slug)) return false;
  try {
    const value = JSON.parse(localStorage.getItem(key(slug)) ?? "null");
    // A choice saved under another consent text is asked again.
    return value?.version === VERSION && typeof value.analytics === "boolean"
      ? value.analytics
      : null;
  } catch {
    return null;
  }
}

export function clearAnalyticsSession(slug: string) {
  try {
    const sid = sessionStorage.getItem(`vayada_sid:${slug}`);
    if (sid) sessionStorage.removeItem(`vayada_funnel_sequence:${sid}`);
    sessionStorage.removeItem(`vayada_sid:${slug}`);
    // Retire the old origin-wide analytics identifier without reusing it.
    const legacy = sessionStorage.getItem("vayada_sid");
    if (legacy) sessionStorage.removeItem(`vayada_funnel_sequence:${legacy}`);
    sessionStorage.removeItem("vayada_sid");
  } catch {}
}

const ALLOWED = "vayada:analytics-allowed";

/** Runs when the guest switches analytics on for this hotel on this page (VAY-2197). */
export function onAnalyticsAllowed(slug: string, listener: () => void): () => void {
  const handle = (event: Event) => {
    if ((event as CustomEvent<string>).detail === slug) listener();
  };
  window.addEventListener(ALLOWED, handle);
  return () => window.removeEventListener(ALLOWED, handle);
}

const OPEN = "vayada:analytics-choices";

/** Opens the analytics prompt again, from the footer's "Privacy choices" link (VAY-2419). The
 * link passes itself to get focus back: Safari doesn't focus a button it clicks. */
export function openAnalyticsChoices(opener: HTMLElement) {
  window.dispatchEvent(new CustomEvent(OPEN, { detail: opener }));
}

export function onAnalyticsChoicesOpened(listener: (opener: HTMLElement) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<HTMLElement>).detail);
  window.addEventListener(OPEN, handle);
  return () => window.removeEventListener(OPEN, handle);
}

export function saveAnalyticsChoice(slug: string, analytics: boolean): boolean {
  if (!analytics) clearAnalyticsSession(slug);
  const before = analyticsChoice(slug);
  try {
    localStorage.setItem(key(slug), JSON.stringify({ version: VERSION, analytics }));
    denied.delete(slug);
    if (analytics && before !== true) {
      try {
        window.dispatchEvent(new CustomEvent(ALLOWED, { detail: slug }));
      } catch {}
    }
    return true;
  } catch {
    denied.add(slug);
    clearAnalyticsSession(slug);
    try {
      localStorage.removeItem(key(slug));
    } catch {}
    return false;
  }
}
