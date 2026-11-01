/** A pin read from a link copied from Google Maps (VAY-2321, shared with onboarding in VAY-2444). */
export type MapsLinkPin = { latitude: number; longitude: number };

const NUMBER = String.raw`(-?\d{1,3}(?:\.\d+)?)`;

/** Whether the text is a Google Maps short share link (maps.app.goo.gl, goo.gl/maps), which carries no coordinates. */
export function isGoogleMapsShortLink(text: string): boolean {
  return /^(https?:\/\/)?(maps\.app\.goo\.gl|goo\.gl\/maps)\//i.test(text.trim());
}

/** Where a link copied from Google Maps puts its pin: a place's own point (!3d…!4d…), a search or route
 * point (?q=, query=, ll=, destination=), else the map's centre (@lat,lng). Short share links
 * (maps.app.goo.gl) carry no coordinates. */
export function parseGoogleMapsLink(text: string): MapsLinkPin | "short_link" | null {
  const link = text.trim();
  if (isGoogleMapsShortLink(link)) return "short_link";
  if (!/google\.[a-z.]+\/maps|maps\.google\./i.test(link)) return null;
  let decoded = link;
  try {
    decoded = decodeURIComponent(link);
  } catch {
    // A malformed escape: read the link as it is.
  }
  const match =
    decoded.match(new RegExp(String.raw`!3d${NUMBER}!4d${NUMBER}`)) ??
    decoded.match(
      new RegExp(String.raw`[?&](?:q|query|ll|destination|center)=${NUMBER},\s*${NUMBER}`),
    ) ??
    decoded.match(new RegExp(String.raw`@${NUMBER},${NUMBER}`));
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    ? { latitude: roundCoordinate(latitude), longitude: roundCoordinate(longitude) }
    : null;
}

/** Six decimals is about 10 cm, as the room editor stores a pin. */
function roundCoordinate(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
