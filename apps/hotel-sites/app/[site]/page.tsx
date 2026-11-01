import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EatAndDrink, Location } from "@/components/EatAndLocation";
import { Footer } from "@/components/Footer";
import { Gallery } from "@/components/Gallery";
import { Hero } from "@/components/Hero";
import { Intro } from "@/components/Intro";
import { Reviews } from "@/components/Reviews";
import { RoomCards, RoomDetails } from "@/components/Rooms";
import { siteBySlug } from "@/sites";

type Props = { params: Promise<{ site: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const site = siteBySlug((await params).site);
  if (!site) return {};
  const { title, description } = site.seo;
  const { image } = site.hero;
  return {
    title,
    description,
    alternates: { canonical: "/" },
    openGraph: {
      type: "website",
      url: "/",
      siteName: site.name,
      title,
      description,
      images: [
        { url: image.src.src, width: image.src.width, height: image.src.height, alt: image.alt },
      ],
    },
  };
}

export default async function SitePage({ params }: Props) {
  const site = siteBySlug((await params).site);
  if (!site) notFound();
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Hotel",
    name: site.name,
    url: site.url,
    image: new URL(site.hero.image.src.src, site.url).href,
    address: {
      "@type": "PostalAddress",
      addressLocality: site.address.locality,
      addressCountry: site.address.countryCode,
    },
  };
  return (
    <>
      <script
        type="application/ld+json"
        // JSON in a script tag: escape "<" so the content can't close the tag.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
        }}
      />
      <Hero site={site} />
      <main>
        <Intro site={site} />
        <RoomCards site={site} />
        <Gallery gallery={site.gallery} />
        {site.reviews && <Reviews reviews={site.reviews} />}
        <RoomDetails site={site} />
        <EatAndDrink eat={site.eat} />
        <Location site={site} />
      </main>
      <Footer site={site} />
    </>
  );
}
