/**
 * VAY-2444: a Google Maps share link (maps.app.goo.gl) carries no coordinates; the long link it redirects to does.
 * A browser can't read a cross-origin redirect, so the API follows it for the host. This is a trust boundary:
 * - only https://maps.app.goo.gl/<code> and https://goo.gl/maps/<code> are ever fetched, with no credentials;
 * - each hop is read from its Location header only (the body is never read or returned), at most three hops;
 * - the answer is the first https Google Maps link on google.com reached (also from Google's consent page's
 *   `continue`), or none; Google refusing us (429, 5xx, its /sorry/ page) is "unavailable", not "unresolved".
 */

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 5_000;
const MAX_LINK_LENGTH = 2_048;
const CODE = /^[A-Za-z0-9_-]{1,64}$/;
// Where a share link lands: google.com only (a country domain or look-alike is refused, the host copies the link).
const GOOGLE_HOST = /^(?:www\.|maps\.)?google\.com$/;

export type ShortLinkResolution =
  | { ok: true; url: string }
  | { ok: false; code: "not_a_short_link" | "unresolved" | "unavailable" };

type Fetch = (input: URL, init: RequestInit) => Promise<Response>;

/** The short link to fetch, normalised to https; null for anything else. */
export function googleMapsShortLink(text: unknown): URL | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_LINK_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  const [, first, second, ...rest] = url.pathname.split("/");
  const shortCode =
    url.hostname === "maps.app.goo.gl"
      ? second === undefined && CODE.test(first ?? "")
      : url.hostname === "goo.gl" &&
        first === "maps" &&
        rest.length === 0 &&
        CODE.test(second ?? "");
  if (!shortCode) return null;
  url.protocol = "https:";
  url.hash = "";
  return url;
}

/** A long Google Maps link the browser can read its pin from, or null. */
export function googleMapsLink(url: URL): URL | null {
  if (url.hostname === "consent.google.com") {
    const target = url.searchParams.get("continue");
    if (!target) return null;
    try {
      return googleMapsLink(new URL(target));
    } catch {
      return null;
    }
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (!GOOGLE_HOST.test(url.hostname)) return null;
  const maps =
    url.pathname === "/maps" ||
    url.pathname.startsWith("/maps/") ||
    (url.hostname === "maps.google.com" && url.pathname === "/");
  return maps && url.href.length <= MAX_LINK_LENGTH * 2 ? url : null;
}

export async function resolveGoogleMapsShortLink(
  text: unknown,
  request: Fetch = (input, init) => fetch(input, init),
): Promise<ShortLinkResolution> {
  let current = googleMapsShortLink(text);
  if (!current) return { ok: false, code: "not_a_short_link" };
  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await request(current, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "text/html" },
      });
    } catch {
      return { ok: false, code: "unavailable" };
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 429 || response.status >= 500)
      return { ok: false, code: "unavailable" };
    const location =
      response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) return { ok: false, code: "unresolved" };
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return { ok: false, code: "unresolved" };
    }
    // Google's "unusual traffic" page: it is refusing our server, not the link.
    if (GOOGLE_HOST.test(next.hostname) && next.pathname.startsWith("/sorry"))
      return { ok: false, code: "unavailable" };
    const link = googleMapsLink(next);
    if (link) return { ok: true, url: link.href };
    // Only another short link is followed; nothing else is ever fetched.
    const short = googleMapsShortLink(next.href);
    if (!short) return { ok: false, code: "unresolved" };
    current = short;
  }
  return { ok: false, code: "unresolved" };
}

/** Resolutions per signed-in person per minute; in memory, as next-api runs as one task (cf. VAY-2222). */
export const SHORT_LINK_LIMIT = 20;
const WINDOW_MS = 60_000;

export type ShortLinkRateLimit = (
  actorId: string,
) => { allowed: true } | { allowed: false; retryAfterSeconds: number };

export function createShortLinkRateLimit(
  options: { now?: () => number; limit?: number } = {},
): ShortLinkRateLimit {
  const now = options.now ?? Date.now;
  const limit = options.limit ?? SHORT_LINK_LIMIT;
  const counts = new Map<string, number>();
  let window = Number.NaN;
  return (actorId) => {
    const at = now();
    const current = Math.floor(at / WINDOW_MS);
    if (current !== window) {
      window = current;
      counts.clear();
    }
    const used = counts.get(actorId) ?? 0;
    if (used >= limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(((current + 1) * WINDOW_MS - at) / 1_000)),
      };
    }
    counts.set(actorId, used + 1);
    return { allowed: true };
  };
}
