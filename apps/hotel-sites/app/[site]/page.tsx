import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Footer } from "@/components/Footer";
import { Hero } from "@/components/Hero";
import { Intro } from "@/components/Intro";
import { siteBySlug } from "@/sites";

type Props = { params: Promise<{ site: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const site = siteBySlug((await params).site);
  if (!site) return {};
  const { title, description, image } = site.seo;
  return {
    metadataBase: new URL(site.url),
    title,
    description,
    alternates: { canonical: "/" },
    robots: { index: site.indexable, follow: site.indexable },
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
    image: new URL(site.seo.image.src.src, site.url).href,
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
      </main>
      <Footer site={site} />
    </>
  );
}
