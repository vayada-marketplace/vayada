import type { CSSProperties, ReactNode } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SITES, siteBySlug } from "@/sites";

import "./site.css";

// One static page per hotel; the middleware maps each request's host to its slug.
export const dynamicParams = false;
export function generateStaticParams() {
  return SITES.map((site) => ({ site: site.slug }));
}

// For every page of the site: absolute URLs, and no indexing while it holds placeholders.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ site: string }>;
}): Promise<Metadata> {
  const site = siteBySlug((await params).site);
  if (!site) return {};
  return {
    metadataBase: new URL(site.url),
    robots: { index: site.indexable, follow: site.indexable },
    // No favicon until the hotel's logo arrives; this stops browsers asking for /favicon.ico.
    icons: { icon: "data:," },
  };
}

export default async function SiteLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ site: string }>;
}) {
  const site = siteBySlug((await params).site);
  if (!site) notFound();
  const { colors } = site;
  const theme = {
    "--site-background": colors.background,
    "--site-ink": colors.ink,
    "--site-text": colors.text,
    "--site-muted": colors.muted,
    "--site-accent": colors.accent,
    "--site-tint": colors.tint,
    "--site-footer": colors.footer,
  } as CSSProperties;
  return (
    <html lang={site.locale} className={site.fontClassName}>
      <body style={theme}>{children}</body>
    </html>
  );
}
