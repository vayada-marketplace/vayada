const key = (slug: string) => `vayada_booking_analytics:${slug}`;
const denied = new Set<string>();

export function analyticsChoice(slug: string): boolean | null {
  if (!slug || typeof window === "undefined") return null;
  if (denied.has(slug)) return false;
  try {
    const value = JSON.parse(localStorage.getItem(key(slug)) ?? "null");
    return value?.version === 1 && typeof value.analytics === "boolean" ? value.analytics : null;
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

export function saveAnalyticsChoice(slug: string, analytics: boolean): boolean {
  if (!analytics) clearAnalyticsSession(slug);
  const before = analyticsChoice(slug);
  try {
    localStorage.setItem(key(slug), JSON.stringify({ version: 1, analytics }));
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
