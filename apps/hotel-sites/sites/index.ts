import { animalsAhangama } from "./animals-ahangama/content";
import type { HotelSite } from "./types";

// A new hotel: its folder (content.ts, assets.ts), an entry here and its hosts in hosts.ts.
export const SITES: HotelSite[] = [animalsAhangama];

export function siteBySlug(slug: string): HotelSite | null {
  return SITES.find((site) => site.slug === slug) ?? null;
}
