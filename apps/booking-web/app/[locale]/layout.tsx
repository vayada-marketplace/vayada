import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { routing } from "@/i18n/routing";
import IntlProviderClient from "@/i18n/IntlProviderClient";
import Providers from "./providers";
import DomainNotConfigured from "@/components/DomainNotConfigured";
import { resolveSlugFromHost } from "@/lib/server/resolveSlug";
import { resolvePublicHotelUrls, type PublicHotelUrlPolicy } from "@/lib/server/publicUrls";

type PublicHotelMetadata = {
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

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

// VAY-394/VAY-663: per-hotel metadata must share the same canonical
// URL policy as JSON-LD and redirect logic. Falls back to the Vayada
// brand only when no hotel can be resolved or the lookup fails.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const headersList = await headers();
  const hostname = headersList.get("host") || "";
  const slug = await resolveSlugFromHost(hostname);
  const fallback: Metadata = {
    title: "Book Your Stay",
    description: "Book your perfect hotel stay.",
    icons: { icon: [{ url: "/vayada-logo.png" }] },
  };
  if (!slug) return fallback;

  const hotel = await fetchPublicHotel(slug, locale);
  if (!hotel) {
    return fallback;
  }
  const policy = resolveHotelUrlPolicy(hostname, requestProtocol(headersList), locale, hotel, slug);
  const favicon = hotel.branding?.faviconUrl || "/vayada-logo.png";

  return {
    title: hotel.name || "Book Your Stay",
    description: hotel.description || "Book your perfect hotel stay.",
    icons: { icon: [{ url: favicon }] },
    alternates: {
      canonical: policy.canonicalUrl,
      languages: policy.hreflangUrls,
    },
    openGraph: {
      title: hotel.name || "Book Your Stay",
      description: hotel.description || "Book your perfect hotel stay.",
      url: policy.canonicalUrl,
      type: "website",
      images: absoluteImages(policy.bookingBaseUrl, [hotel.heroImage, ...(hotel.images || [])]),
    },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);

  const messages = await getMessages();

  const headersList = await headers();
  const hostname = headersList.get("host") || "";
  // `undefined` is dev-only — the HotelProvider's client effect resolves
  // the slug from ?slug=/localStorage so a single dev container can
  // serve any hotel. `null` is a real production miss → render the
  // Domain Not Configured page instead of falling through to a wrong
  // hotel (see VAY-394: the previous `hotel-alpenrose` fallback caused
  // guests to see "Hotel 'hotel-alpenrose' not found" on misconfigured
  // custom domains).
  const slug = await resolveSlugFromHost(hostname);
  const hotel = slug ? await fetchPublicHotel(slug, locale) : null;
  const policy = hotel
    ? resolveHotelUrlPolicy(
        hostname,
        requestProtocol(headersList),
        locale,
        hotel,
        slug || hotel.slug || "",
      )
    : null;

  if (slug === null) {
    return (
      <html lang={locale}>
        <body className="font-body">
          <DomainNotConfigured hostname={hostname} />
        </body>
      </html>
    );
  }

  return (
    <html lang={locale}>
      <body className="font-body">
        <HotelStructuredData hotel={hotel} policy={policy} />
        <IntlProviderClient locale={locale} messages={messages}>
          <Providers locale={locale} slug={slug}>
            {children}
          </Providers>
        </IntlProviderClient>
      </body>
    </html>
  );
}

async function fetchPublicHotel(slug: string, locale: string): Promise<PublicHotelMetadata | null> {
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

function resolveHotelUrlPolicy(
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
    supportedLocales: hotel.supportedLanguages,
    customDomainUrl: hotel.customDomainUrl,
  });
}

function requestProtocol(headersList: Headers): "http" | "https" {
  const forwardedProto = headersList.get("x-forwarded-proto");
  if (forwardedProto === "http" || forwardedProto === "https") return forwardedProto;
  const host = headersList.get("host") || "";
  return host.includes(":3002") || host.startsWith("127.0.0.1") ? "http" : "https";
}

function absoluteImages(baseUrl: string, images: Array<string | undefined>): string[] {
  return images
    .filter((image): image is string => Boolean(image))
    .map((image) => new URL(image, baseUrl).toString());
}

function HotelStructuredData({
  hotel,
  policy,
}: {
  hotel: PublicHotelMetadata | null;
  policy: PublicHotelUrlPolicy | null;
}) {
  if (!hotel || !policy) return null;

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Hotel",
    "@id": `${policy.jsonLdUrl}#hotel`,
    name: hotel.name,
    description: hotel.description,
    url: policy.jsonLdUrl,
    image: absoluteImages(policy.bookingBaseUrl, [hotel.heroImage, ...(hotel.images || [])]),
    starRating: hotel.starRating ? { "@type": "Rating", ratingValue: hotel.starRating } : undefined,
    address: {
      "@type": "PostalAddress",
      streetAddress: hotel.contact?.address,
      addressLocality: hotel.location,
      addressCountry: hotel.country,
    },
    checkinTime: hotel.checkInTime,
    checkoutTime: hotel.checkOutTime,
  };
  const structuredDataJson = JSON.stringify(structuredData).replace(/</g, "\\u003c");

  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredDataJson }} />
  );
}
