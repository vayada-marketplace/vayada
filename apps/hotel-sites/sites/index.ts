import { animalsAhangama } from "./animals-ahangama/content";
import type { HotelSite } from "./types";

// A new hotel: its folder (content.ts, assets.ts) and an entry here. Its `url` names its build folder.
export const SITES: HotelSite[] = [animalsAhangama];

export function siteBySlug(slug: string): HotelSite | null {
  return SITES.find((site) => site.slug === slug) ?? null;
}
