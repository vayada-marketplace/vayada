"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Hotel, Addon } from "@/lib/types";
import { hotelService } from "@/services/api/hotel";
import { getAgencyPage, type AgencyPage } from "@/services/api/agencyPage";
import { ApiError } from "@/services/api/client";
import { routing } from "@/i18n/routing";
import { generateColorPalette, generateOnColorPalette } from "@/lib/utils/colors";
import { brandFontPairing } from "@vayada/fonts/brand";
import { stayPath } from "@/lib/stayPath";

// Rooms, availability and prices are served by the room-and-price page (/book); this
// provider only carries the hotel profile and its add-on catalogue. An agency's address
// (VAY-2459) carries its page instead, and `hotel` stays null.
interface HotelContextValue {
  hotel: Hotel | null;
  agency: AgencyPage | null;
  addons: Addon[];
  loading: boolean;
  error: string | null;
  locale: string;
  slug: string;
  /** Where the stay's own pages (checkout, its bookings) start on this address: "" on a hotel's
   * (VAY-2462). */
  basePath: string;
}

const HotelContext = createContext<HotelContextValue>({
  hotel: null,
  agency: null,
  addons: [],
  loading: true,
  error: null,
  locale: "en",
  slug: "",
  basePath: "",
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

// An agency page has only its overview so far ("/", "/de"); its checkout comes with VAY-2462.
const HOME_PATH = new RegExp(`^/(?:(?:${routing.locales.join("|")})/?)?$`);
// VAY-2461: one of an agency's stays on its address.
const STAY_PATH = new RegExp(`^/(?:(?:${routing.locales.join("|")})/)?stays/([^/]+)/?$`);

/** The stay a path names on an agency's address (`/stays/<slug>`), else null. */
export function stayPathSlug(pathname: string): string | null {
  const match = STAY_PATH.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

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
  const pathname = usePathname();
  const quoteEntry = /\/book\/?$/.test(pathname);
  const home = HOME_PATH.test(pathname);
  const [hotel, setHotel] = useState<Hotel | null>(null);
  const [agency, setAgency] = useState<AgencyPage | null>(null);
  // The address whose agency page is here: it doesn't change with the language or the path.
  const agencySlug = useRef<string | null>(null);
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
    if (agencySlug.current === slug) return;
    setAgency(null);
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
      .catch(async (err) => {
        if (canceled) return;
        // VAY-2459: no hotel at this address; an agency page may have it (one address space).
        if (err instanceof ApiError && err.status === 404) {
          try {
            const page = await getAgencyPage(slug);
            if (canceled) return;
            // A page without a ready stay has nothing to show yet.
            if (!page.stays.length) throw new ApiError("No stays yet.", 404, null);
            agencySlug.current = slug;
            setAgency(page);
            setLoading(false);
            return;
          } catch (agencyErr) {
            if (canceled) return;
            err = agencyErr;
          }
        }
        if (err instanceof ApiError && err.status === 404) setNotOnline(true);
        else setError(err instanceof Error ? err.message : "Failed to load hotel data");
        setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [locale, slug, slugResolved, quoteEntry]);

  // Apply branding colors as CSS variables (an agency's: its design stay's, VAY-2459)
  const primaryColor = hotel?.branding?.primaryColor ?? agency?.design.primaryColor;
  useEffect(() => {
    if (primaryColor) {
      const palette = {
        ...generateColorPalette(primaryColor),
        ...generateOnColorPalette(primaryColor),
      };
      const root = document.documentElement;
      for (const [shade, color] of Object.entries(palette)) {
        root.style.setProperty(`--color-primary-${shade}`, color);
      }
    }
  }, [primaryColor]);

  // Apply accent color (card/section backgrounds)
  useEffect(() => {
    if (hotel?.branding?.accentColor) {
      document.documentElement.style.setProperty("--color-accent", hotel.branding.accentColor);
    }
  }, [hotel?.branding?.accentColor]);

  // Apply the branding font pairing (self-hosted, see packages/fonts) as CSS variables
  const fontPairing = hotel?.branding?.fontPairing ?? agency?.design.fontPairing ?? undefined;
  useEffect(() => {
    const pairing = brandFontPairing(fontPairing);
    if (pairing) {
      const root = document.documentElement;
      root.style.setProperty("--font-heading", pairing.heading);
      root.style.setProperty("--font-body", pairing.body);
    }
  }, [fontPairing]);

  // An agency's address has its overview and its stays' pages (VAY-2461), only for the stays it
  // shows; a hotel's has no stay pages.
  const staySlug = stayPathSlug(pathname);
  const offline =
    notOnline ||
    (agency
      ? !home && !(staySlug && agency.stays.some((stay) => stay.slug === staySlug))
      : !!hotel && staySlug !== null);
  if (offline || error) {
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
            {offline ? t("notOnline") : t("unableToLoad")}
          </h2>
          <p className="text-sm text-gray-600 mb-4">
            {offline ? t("checkBackLater") : t("tryAgainLater")}
          </p>
          {!offline && (
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

  // The first load only. A hotel fetched again (moving between /book and the other pages, which
  // load the add-ons) keeps the page mounted: a remount would lose what it read once on arrival,
  // such as the room to change or a room's Undo (VAY-2393).
  if (loading && !hotel && !agency) {
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
        agency,
        addons,
        loading,
        error,
        locale,
        slug: slug ?? "",
        basePath: "",
      }}
    >
      {children}
    </HotelContext.Provider>
  );
}

/**
 * One stay of an agency's page, on the agency's address (VAY-2461): the stay's own profile and
 * add-ons for its rooms, inside the agency's page, which keeps its look (no colours or fonts of
 * the stay's) and its context (`useAgencyPage`). While the stay loads, a spinner stands in.
 */
export function StayHotelProvider({ slug, children }: { slug: string; children: ReactNode }) {
  const outer = useContext(HotelContext);
  const t = useTranslations("error");
  const tc = useTranslations("common");
  const [state, setState] = useState<{
    slug: string;
    hotel?: Hotel;
    addons?: Addon[];
    error?: string;
    notOnline?: boolean;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let canceled = false;
    Promise.all([
      hotelService.getHotel(slug, outer.locale),
      hotelService.getAddons(slug).catch(() => [] as Addon[]),
    ])
      .then(([hotel, addons]) => {
        if (!canceled) setState({ slug, hotel, addons });
      })
      .catch((err) => {
        if (!canceled)
          setState({
            slug,
            error: err instanceof Error ? err.message : "Failed to load hotel data",
            // Gone between the agency's read and this one: retrying can't help.
            notOnline: err instanceof ApiError && err.status === 404,
          });
      });
    return () => {
      canceled = true;
    };
  }, [slug, outer.locale, attempt]);
  const current = state?.slug === slug ? state : null;
  if (current?.error)
    return (
      <div role="alert" className="mx-auto max-w-md px-4 py-16 text-center">
        <h2 className="mb-2 text-lg font-bold text-gray-900">
          {current.notOnline ? t("notOnline") : t("unableToLoad")}
        </h2>
        <p className="mb-4 text-sm text-gray-600">
          {current.notOnline ? t("checkBackLater") : t("tryAgainLater")}
        </p>
        {!current.notOnline && (
          <button
            type="button"
            onClick={() => {
              setState(null);
              setAttempt((value) => value + 1);
            }}
            className="rounded-full bg-gray-900 px-6 py-2.5 text-sm font-semibold text-white hover:bg-gray-800"
          >
            {t("retry")}
          </button>
        )}
      </div>
    );
  if (!current?.hotel)
    return (
      <div role="status" className="flex justify-center py-24" aria-busy="true">
        <span className="sr-only">{tc("loading")}</span>
        <div
          aria-hidden="true"
          className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-gray-900"
        />
      </div>
    );
  return (
    <HotelContext.Provider
      value={{
        ...outer,
        hotel: current.hotel,
        addons: current.addons ?? [],
        loading: false,
        error: null,
        slug,
      }}
    >
      {children}
    </HotelContext.Provider>
  );
}

export function useHotel() {
  const { hotel, loading, error } = useContext(HotelContext);
  return { hotel: hotel!, loading, error };
}

/** The agency page at this address (VAY-2459); null on a hotel's. */
export function useAgencyPage() {
  const { agency } = useContext(HotelContext);
  return { agency };
}

export function useAddons() {
  const { addons, loading, error } = useContext(HotelContext);
  return { addons, loading, error };
}

export function useSlug() {
  const { slug } = useContext(HotelContext);
  return { slug };
}

/** A page of the stay being booked on this address (VAY-2462), from its path on a hotel's own
 * address ("/", "/book?…", "/booking/<reference>"): as is there, under the stay on an agency's. */
export function useStayPath() {
  const { basePath } = useContext(HotelContext);
  return useCallback((path: string) => stayPath(basePath, path), [basePath]);
}
