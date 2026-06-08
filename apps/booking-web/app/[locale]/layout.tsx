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
import type { PublicHotelUrlPolicy } from "@/lib/server/publicUrls";
import {
  absoluteImages,
  buildPublicHotelMetadata,
  fallbackHotelMetadata,
  fetchPublicHotel,
  requestProtocol,
  resolveHotelUrlPolicy,
  type PublicHotelMetadata,
} from "@/lib/server/publicHotelMetadata";

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
  if (!slug) return fallbackHotelMetadata;

  const hotel = await fetchPublicHotel(slug, locale);
  if (!hotel) {
    return fallbackHotelMetadata;
  }
  const policy = resolveHotelUrlPolicy(hostname, requestProtocol(headersList), locale, hotel, slug);
  return buildPublicHotelMetadata({ hotel, policy, path: "/" });
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
