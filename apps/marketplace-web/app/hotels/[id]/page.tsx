"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Navigation, Footer } from "@/components/layout";
import {
  loadMarketplacePublicHotel,
  type MarketplacePublicHotel,
} from "@/services/api/marketplacePublicHotel";

export default function HotelDetailPage() {
  const params = useParams();
  const propertyId = Array.isArray(params.id) ? params.id[0] : params.id;
  const [result, setResult] = useState<{
    propertyId: string;
    hotel: MarketplacePublicHotel | null;
    error: boolean;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!propertyId) return;
    const controller = new AbortController();
    setResult(null);
    loadMarketplacePublicHotel(propertyId, controller.signal).then(
      (hotel) => {
        if (!controller.signal.aborted) setResult({ propertyId, hotel, error: false });
      },
      () => {
        if (!controller.signal.aborted) setResult({ propertyId, hotel: null, error: true });
      },
    );
    return () => controller.abort();
  }, [propertyId, retry]);
  const current = result?.propertyId === propertyId ? result : null;
  const hotel = current?.hotel;
  const cover = hotel?.media.find((item) => item.mediaType === "hero_image");
  const logo = hotel?.media.find((item) => item.mediaType === "logo");
  const gallery = hotel?.media.filter((item) => item.mediaType === "gallery_image") ?? [];
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <Navigation />
      <main className="mx-auto max-w-6xl px-4 pb-20 pt-28 sm:px-8">
        <Link href="/marketplace" className="text-sm font-medium text-primary-700 hover:underline">
          Back to Marketplace
        </Link>
        {!current ? (
          <p role="status" className="py-20">
            Loading hotel details…
          </p>
        ) : !hotel ? (
          <section className="py-20">
            <h1 className="text-3xl font-semibold">
              {current.error
                ? "Hotel details are temporarily unavailable"
                : "Hotel profile unavailable"}
            </h1>
            <p className="mt-4 text-gray-600">
              {current.error
                ? "Please try again in a moment."
                : "This hotel does not have an active public Marketplace profile."}
            </p>
            <button
              type="button"
              className="mt-6 rounded-lg bg-primary-600 px-5 py-3 font-semibold text-white"
              onClick={() => setRetry((value) => value + 1)}
            >
              Try again
            </button>
          </section>
        ) : (
          <article className="mt-8">
            {cover && (
              <img
                src={cover.url}
                alt={cover.altText ?? hotel.displayName}
                className="mb-10 aspect-[16/7] w-full rounded-2xl object-cover"
              />
            )}
            <header className="flex items-center gap-6">
              {logo && (
                <img
                  src={logo.url}
                  alt={logo.altText ?? `${hotel.displayName} logo`}
                  className="h-20 w-20 shrink-0 rounded-xl object-contain"
                />
              )}
              <div>
                <p className="mb-2 text-sm capitalize text-gray-500">
                  {hotel.propertyType.replaceAll("_", " ")}
                </p>
                <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">
                  {hotel.displayName}
                </h1>
                {hotel.locality && (
                  <p className="mt-3 text-gray-600">
                    {[hotel.locality.city, hotel.locality.countryCode].filter(Boolean).join(", ")}
                  </p>
                )}
              </div>
            </header>
            <p className="mt-10 max-w-3xl whitespace-pre-line text-lg leading-relaxed text-gray-700">
              {hotel.shortDescription}
            </p>
            {gallery.length > 0 && (
              <section aria-label="Hotel photos" className="mt-12 grid gap-4 sm:grid-cols-2">
                {gallery.map((item, index) => (
                  <img
                    key={`${item.url}-${index}`}
                    src={item.url}
                    alt={item.altText ?? `${hotel.displayName} photo ${index + 1}`}
                    loading="lazy"
                    className="aspect-[4/3] w-full rounded-xl object-cover"
                  />
                ))}
              </section>
            )}
          </article>
        )}
      </main>
      <Footer />
    </div>
  );
}
