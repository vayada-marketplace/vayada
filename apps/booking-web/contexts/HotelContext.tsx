"use client";

import { createContext, useContext, useEffect, useState, ReactNode, Suspense } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { AffiliateClickTracker } from "@/components/AffiliateClickTracker";
import { Hotel, Addon } from "@/lib/types";
import { hotelService } from "@/services/api/hotel";
import { ApiError } from "@/services/api/client";
import { generateColorPalette } from "@/lib/utils/colors";
import { brandFontPairing } from "@/lib/brandFonts";

// Rooms, availability and prices are served by the room-and-price page (/book); this
// provider only carries the hotel profile and its add-on catalogue.
interface HotelContextValue {
  hotel: Hotel | null;
  addons: Addon[];
  loading: boolean;
  error: string | null;
  locale: string;
  slug: string;
}

const HotelContext = createContext<HotelContextValue>({
  hotel: null,
  addons: [],
  loading: true,
  error: null,
  locale: "en",
  slug: "",
});

// Resolve the active hotel slug. In production the server layout has
// already resolved it from the request hostname and passes it down via
// the `slug` prop. For local development we let the slug be overridden
// at runtime so a single dev container can serve any hotel:
//   1. `?slug=<name>` query param (also persisted to localStorage)
//   2. `dev-hotel-slug` localStorage key
//   3. NEXT_PUBLIC_HOTEL_SLUG env var
//
// VAY-394: no longer falls back to a hardcoded `hotel-alpenrose` — when
// no slug can be resolved we return `null` so the provider can render
// a clear error instead of fetching a dev seed slug that 404s in prod.
const DEV_SLUG_STORAGE_KEY = "dev-hotel-slug";

function resolveSlug(slugProp?: string): string | null {
  if (slugProp) return slugProp;
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const querySlug = params.get("slug");
    if (querySlug) {
      try {
        localStorage.setItem(DEV_SLUG_STORAGE_KEY, querySlug);
      } catch {}
      return querySlug;
    }
    try {
      const stored = localStorage.getItem(DEV_SLUG_STORAGE_KEY);
      if (stored) return stored;
    } catch {}
  }
  return process.env.NEXT_PUBLIC_HOTEL_SLUG || null;
}

export function HotelProvider({
  children,
  locale = "en",
  slug: slugProp,
}: {
  children: ReactNode;
  locale?: string;
  slug?: string;
}) {
  // Server render passes the resolved slug; we hold it as `null`
  // until the client effect either confirms it or runs the dev-mode
  // fallback (?slug=/localStorage). Keeping the initial state stable
  // between SSR and hydration avoids a flash of the wrong hotel.
  const [slug, setSlug] = useState<string | null>(() => slugProp || null);
  // Server render skips the fetch; client sets this to true after
  // resolving the slug so the fetch effect fires exactly once with
  // the correct value.
  const [slugResolved, setSlugResolved] = useState<boolean>(false);
  useEffect(() => {
    setSlug(resolveSlug(slugProp));
    setSlugResolved(true);
  }, [slugProp]);
  const quoteEntry = /\/book\/?$/.test(usePathname());
  const [hotel, setHotel] = useState<Hotel | null>(null);
  const [addons, setAddons] = useState<Addon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // VAY-2189: no booking page is online for this URL (the hotel request
  // answered 404, or no slug resolved). Retrying can't help, so the card
  // says so calmly instead of offering Retry.
  const [notOnline, setNotOnline] = useState(false);
  const t = useTranslations("error");

  useEffect(() => {
    if (!slugResolved) return;
    if (!slug) {
      // No slug to fetch — stop showing the loading spinner so the
      // user sees the not-online message below.
      setLoading(false);
      setNotOnline(true);
      return;
    }
    let canceled = false;
    setLoading(true);
    setError(null);
    setNotOnline(false);
    Promise.all([
      hotelService.getHotel(slug, locale),
      quoteEntry
        ? Promise.resolve([] as Addon[])
        : hotelService.getAddons(slug).catch(() => [] as Addon[]),
    ])
      .then(([hotelData, addonsData]) => {
        if (canceled) return;
        setHotel(hotelData);
        setAddons(addonsData);
        setLoading(false);
        // VAY-394: API returned a different canonical slug than we
        // requested — the property was renamed and we landed via its
        // old subdomain. Redirect the browser to the canonical
        // subdomain so address-bar copy/share uses the new name.
        if (typeof window !== "undefined" && hotelData?.slug && hotelData.slug !== slug) {
          const host = window.location.hostname;
          if (host.endsWith(".booking.vayada.com") || host.endsWith(".next-booking.vayada.com")) {
            const parts = host.split(".");
            if (parts[0] === slug) {
              parts[0] = hotelData.slug;
              const url = `${window.location.protocol}//${parts.join(".")}${window.location.pathname}${window.location.search}${window.location.hash}`;
              window.location.replace(url);
            }
          }
        }
      })
      .catch((err) => {
        if (canceled) return;
        if (err instanceof ApiError && err.status === 404) setNotOnline(true);
        else setError(err instanceof Error ? err.message : "Failed to load hotel data");
        setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [locale, slug, slugResolved, quoteEntry]);

  // Apply branding colors as CSS variables
  useEffect(() => {
    if (hotel?.branding?.primaryColor) {
      const palette = generateColorPalette(hotel.branding.primaryColor);
      const root = document.documentElement;
      for (const [shade, color] of Object.entries(palette)) {
        root.style.setProperty(`--color-primary-${shade}`, color);
      }
    }
  }, [hotel?.branding?.primaryColor]);

  // Apply accent color (card/section backgrounds)
  useEffect(() => {
    if (hotel?.branding?.accentColor) {
      document.documentElement.style.setProperty("--color-accent", hotel.branding.accentColor);
    }
  }, [hotel?.branding?.accentColor]);

  // Apply the branding font pairing (self-hosted, see lib/brandFonts) as CSS variables
  useEffect(() => {
    const pairing = brandFontPairing(hotel?.branding?.fontPairing);
    if (pairing) {
      const root = document.documentElement;
      root.style.setProperty("--font-heading", pairing.heading);
      root.style.setProperty("--font-body", pairing.body);
    }
  }, [hotel?.branding?.fontPairing]);

  if (notOnline || error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="bg-white rounded-2xl border border-red-200 shadow-sm p-8 max-w-md w-full text-center">
          <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-6 h-6 text-red-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-gray-900 mb-2">
            {notOnline ? t("notOnline") : t("unableToLoad")}
          </h2>
          <p className="text-sm text-gray-600 mb-4">
            {notOnline ? t("checkBackLater") : t("tryAgainLater")}
          </p>
          {!notOnline && (
            <>
              <div className="bg-red-50 rounded-lg p-3 mb-6">
                <p className="text-sm text-red-700 font-mono break-all">{error}</p>
              </div>
              <button
                onClick={() => window.location.reload()}
                className="px-6 py-2.5 bg-gray-900 text-white font-semibold rounded-full hover:bg-gray-800 transition-colors text-sm"
              >
                {t("retry")}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="animate-spin w-8 h-8 border-4 border-gray-200 border-t-gray-900 rounded-full" />
      </div>
    );
  }

  return (
    <HotelContext.Provider
      value={{
        hotel,
        addons,
        loading,
        error,
        locale,
        slug: slug ?? "",
      }}
    >
      {children}
      {slugResolved && slug && (
        <Suspense fallback={null}>
          <AffiliateClickTracker slug={slug} />
        </Suspense>
      )}
    </HotelContext.Provider>
  );
}

export function useHotel() {
  const { hotel, loading, error } = useContext(HotelContext);
  return { hotel: hotel!, loading, error };
}

export function useAddons() {
  const { addons, loading, error } = useContext(HotelContext);
  return { addons, loading, error };
}

export function useSlug() {
  const { slug } = useContext(HotelContext);
  return { slug };
}
