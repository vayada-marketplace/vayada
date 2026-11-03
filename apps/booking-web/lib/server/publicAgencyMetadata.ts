import type { Metadata } from "next";
import { cache } from "react";

import { routing } from "@/i18n/routing";
import { resolvePublicHotelUrls } from "@/lib/server/publicUrls";
import { fallbackHotelMetadata } from "@/lib/server/publicHotelMetadata";
import { readAgencyPage, type AgencyPage } from "@/services/api/agencyPage";

const REVALIDATE_SECONDS = 60;

/** A live agency page for the link previews and the title (VAY-2459); null when there is none. */
export const fetchPublicAgencyPage = cache(async (slug: string): Promise<AgencyPage | null> => {
  const apiUrl =
    process.env.BOOKING_WEB_API_URL ||
    process.env.NEXT_PUBLIC_BOOKING_WEB_API_URL ||
    "https://api.localhost";
  try {
    const res = await fetch(`${apiUrl}/api/booking-web/agency-pages/${encodeURIComponent(slug)}`, {
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!res.ok) return null;
    return readAgencyPage(await res.json());
  } catch {
    return null;
  }
});

/** The agency page's title and description (Settings › page title, VAY-2457), its header image
 * for link previews, and its address in each of its languages. */
export function buildPublicAgencyMetadata({
  agency,
  hostname,
  protocol,
  locale,
}: {
  agency: AgencyPage;
  hostname: string;
  protocol: "http" | "https";
  locale: string;
}): Metadata {
  const supported = (agency.locales?.supported ?? []).filter((code) =>
    routing.locales.includes(code as (typeof routing.locales)[number]),
  );
  const policy = resolvePublicHotelUrls({
    requestHost: hostname,
    requestProtocol: protocol,
    slug: agency.slug,
    locale,
    supportedLocales: supported.length ? supported : [locale],
    customDomainUrl: null,
  });
  const description = agency.page.description || String(fallbackHotelMetadata.description);
  return {
    title: agency.page.title,
    description,
    icons: fallbackHotelMetadata.icons,
    alternates: { canonical: policy.canonicalUrl, languages: policy.hreflangUrls },
    openGraph: {
      title: agency.page.title,
      description,
      url: policy.canonicalUrl,
      type: "website",
      images: agency.header.imageUrl ? [agency.header.imageUrl] : [],
    },
  };
}
