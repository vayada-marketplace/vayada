import type { Metadata } from "next";

import { routing } from "@/i18n/routing";
import {
  publicHotelPageHreflangUrls,
  publicHotelPageUrl,
  resolvePublicHotelUrls,
  type PublicHotelCrawlPath,
  type PublicHotelUrlPolicy,
} from "@/lib/server/publicUrls";

export type PublicHotelMetadata = {
  name?: string;
  slug?: string;
  description?: string;
  country?: string;
  location?: string;
  starRating?: number;
  heroImage?: string;
  images?: string[];
  checkInTime?: string;
  checkOutTime?: string;
  contact?: { address?: string; phone?: string; email?: string };
  branding?: { faviconUrl?: string };
  customDomainUrl?: string | null;
  supportedLanguages?: string[];
};

export const fallbackHotelMetadata: Metadata = {
  title: "Book Your Stay",
  description: "Book your perfect hotel stay.",
  icons: { icon: [{ url: "/vayada-logo.png" }] },
};

export async function fetchPublicHotel(
  slug: string,
  locale: string,
): Promise<PublicHotelMetadata | null> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "https://api.booking.localhost";
  const langParam = locale !== "en" ? `?lang=${locale}` : "";
  try {
    const res = await fetch(`${apiUrl}/api/hotels/${slug}${langParam}`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as PublicHotelMetadata;
  } catch {
    return null;
  }
}

export function resolveHotelUrlPolicy(
  hostname: string,
  protocol: "http" | "https",
  locale: string,
  hotel: PublicHotelMetadata,
  fallbackSlug: string,
): PublicHotelUrlPolicy {
  return resolvePublicHotelUrls({
    requestHost: hostname,
    requestProtocol: protocol,
    slug: hotel.slug || fallbackSlug,
    locale,
    supportedLocales: supportedRoutingLocales(hotel.supportedLanguages, locale),
    customDomainUrl: hotel.customDomainUrl,
  });
}

export function buildPublicHotelMetadata({
  hotel,
  policy,
  path,
}: {
  hotel: PublicHotelMetadata;
  policy: PublicHotelUrlPolicy;
  path: PublicHotelCrawlPath;
}): Metadata {
  const canonicalUrl = publicHotelPageUrl(policy, path);
  const favicon = hotel.branding?.faviconUrl || "/vayada-logo.png";

  return {
    title: hotel.name || fallbackHotelMetadata.title,
    description: hotel.description || String(fallbackHotelMetadata.description),
    icons: { icon: [{ url: favicon }] },
    alternates: {
      canonical: canonicalUrl,
      languages: publicHotelPageHreflangUrls(policy, path),
    },
    openGraph: {
      title: hotel.name || "Book Your Stay",
      description: hotel.description || "Book your perfect hotel stay.",
      url: canonicalUrl,
      type: "website",
      images: absoluteImages(policy.bookingBaseUrl, [hotel.heroImage, ...(hotel.images || [])]),
    },
  };
}

export function requestProtocol(headersList: Headers): "http" | "https" {
  const forwardedProto = headersList.get("x-forwarded-proto");
  if (forwardedProto === "http" || forwardedProto === "https") return forwardedProto;
  const host = headersList.get("host") || "";
  return host.includes(":3002") || host.startsWith("127.0.0.1") ? "http" : "https";
}

export function absoluteImages(baseUrl: string, images: Array<string | undefined>): string[] {
  return images
    .filter((image): image is string => Boolean(image))
    .map((image) => new URL(image, baseUrl).toString());
}

function supportedRoutingLocales(locales: string[] | undefined, fallbackLocale: string): string[] {
  const supported = (locales || []).filter((locale) =>
    routing.locales.includes(locale as (typeof routing.locales)[number]),
  );
  if (supported.length > 0) return supported;
  return routing.locales.includes(fallbackLocale as (typeof routing.locales)[number])
    ? [fallbackLocale]
    : [routing.defaultLocale];
}
