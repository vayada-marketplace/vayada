import { routing } from "@/i18n/routing";

/**
 * A page of the stay being booked, on this address (VAY-2462): as is on a hotel's own address,
 * under the stay on an agency's (`/stays/<slug>/book`, `/stays/<slug>/booking/<reference>`). The
 * stay's home ("/") is its rooms: its own page, or the stay page on the agency's address.
 *
 * `base` is "" on a hotel's address, so every path stays exactly as it was there.
 */
export function stayPath(base: string, path: string): string {
  if (!base) return path;
  if (path === "/") return base;
  if (path.startsWith("/?") || path.startsWith("/#")) return base + path.slice(1);
  return base + path;
}

/** Where a stay's pages start on its agency's address (VAY-2462). */
export function agencyStayBase(staySlug: string): string {
  return `/stays/${encodeURIComponent(staySlug)}`;
}

// VAY-2461: a stay's page on its agency's address; VAY-2462: its checkout and bookings under it.
const AGENCY_STAY_PATH = new RegExp(
  `^/(?:(?:${routing.locales.join("|")})/)?stays/([^/]+)(?:/.*)?$`,
);

/** The stay a path is about on an agency's address (`/stays/<slug>…`), else null. */
export function agencyStayPathSlug(pathname: string): string | null {
  const match = AGENCY_STAY_PATH.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}
