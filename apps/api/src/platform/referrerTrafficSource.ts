export type ReferrerTrafficSource =
  | "instagram"
  | "tiktok"
  | "youtube"
  | "facebook"
  | "x"
  | "unknown";

/** Browser referrer is advisory traffic metadata; only the referring site is kept. */
export function referrerTrafficSource(referrer: unknown): ReferrerTrafficSource {
  if (typeof referrer !== "string" || !referrer) return "unknown";
  let hostname: string;
  try {
    const url = new URL(referrer);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "unknown";
    hostname = url.hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  const matches = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
  if (matches("instagram.com")) return "instagram";
  if (matches("tiktok.com")) return "tiktok";
  if (matches("youtube.com") || matches("youtu.be")) return "youtube";
  if (matches("facebook.com") || matches("fb.com")) return "facebook";
  if (matches("x.com") || matches("twitter.com")) return "x";
  return "unknown";
}
