"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type {
  AccountBookingPageLayout,
  AccountBookingPageSort,
} from "@vayada/domain-booking/account-booking-page";
import StayHero from "@/components/booking/StayHero";
import StaySearchCard, { type SearchPanel } from "@/components/booking/StaySearchCard";
import PromoField from "@/components/booking/PromoField";
import ApproximateAmountsNote from "@/components/booking/ApproximateAmountsNote";
import BookingNavigation from "@/components/layout/BookingNavigation";
import AgencyStayCard, { type AgencyCardText } from "@/components/agency/AgencyStayCard";
import AgencyFullStays from "@/components/agency/AgencyFullStays";
import AgencyFilters from "@/components/agency/AgencyFilters";
import AgencyFilterSheet from "@/components/agency/AgencyFilterSheet";
import AgencyStayMap, { AgencyLayoutSwitch } from "@/components/agency/AgencyStayMap";
import AgencyPhoneMap from "@/components/agency/AgencyPhoneMap";
import { useWideScreen } from "@/components/booking/AccommodationViews";
import { useCurrency } from "@/contexts/CurrencyContext";
import { ApiError } from "@/services/api/client";
import {
  getAgencyStayPrices,
  type AgencyPage,
  type AgencySearch,
  type AgencyStayPrices,
} from "@/services/api/agencyPage";
import {
  activeFilterCount,
  agencyFilterOptions,
  agencyResults,
  filtersActive,
  formatStayRange,
  hasFilterChips,
  NO_FILTERS,
  stayHref,
  stayNights,
  stayTypeName,
  type AgencyCard,
  type AgencyFilters as Filters,
} from "@/lib/agencyOverview";
import { chooseMaps } from "@/lib/mapsChoice";
import { mostRooms } from "@/lib/roomPicker";
import { ensureMinOneNight } from "@/lib/utils";

/** Google Maps' browser key; without one, the agency page has only its list. */
const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() ?? "";
/** The longest search the agency price read takes (VAY-2458 `AGENCY_MAX_NIGHTS`). */
const MAX_NIGHTS = 30;
const SORTS: AccountBookingPageSort[] = ["price_low", "price_high", "recommended"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const sameSearch = (a: AgencySearch, b: AgencySearch) =>
  a.checkIn === b.checkIn &&
  a.checkOut === b.checkOut &&
  a.adults === b.adults &&
  a.children === b.children &&
  a.rooms === b.rooms &&
  a.promoCode === b.promoCode;

const pad = (n: number) => String(n).padStart(2, "0");
function localDate(daysFromToday: number) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
const whole = (value: string | null, min: number, max: number, fallback: number) => {
  const n = Number(value);
  return value !== null && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

/** The search in the address (Back from a stay, a shared link), else tomorrow for one night. */
function searchFromUrl(params: URLSearchParams, childrenEnabled: boolean): AgencySearch {
  let checkIn = params.get("checkIn") ?? "";
  if (!DATE.test(checkIn) || checkIn < localDate(0)) checkIn = localDate(1);
  let checkOut = params.get("checkOut") ?? "";
  if (!DATE.test(checkOut) || stayNights(checkIn, checkOut) > MAX_NIGHTS) checkOut = "";
  const dates = ensureMinOneNight(checkIn, checkOut);
  const adults = whole(params.get("adults"), 1, 10, 2);
  const promo = params.get("promoCode")?.trim().toUpperCase() ?? "";
  return {
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
    adults,
    children: childrenEnabled ? whole(params.get("children"), 0, 6, 0) : 0,
    rooms: Math.min(whole(params.get("rooms"), 1, 9, 1), adults),
    promoCode: promo && promo.length <= 200 ? promo : null,
  };
}

/**
 * The agency booking page's overview (VAY-2459, the List layout of Timo's "The Travel Ubud"): the
 * agency's header and the search card of a hotel page, then every live stay as a card for the
 * search, sorted as the guest chooses, with full stays and their next free dates at the end.
 * "View rooms" opens the stay's own page with the same search.
 */
export default function AgencyOverview({ agency }: { agency: AgencyPage }) {
  const t = useTranslations("agency");
  const th = useTranslations("home");
  const tm = useTranslations("locationMap");
  const locale = useLocale();
  const searchParams = useSearchParams();
  const { baseCurrency, rates, approximate, selectedCurrency, convertPrice } = useCurrency();
  const childrenEnabled = agency.stays.some((stay) => stay.childrenEnabled);
  const [initial] = useState(() => searchFromUrl(searchParams, childrenEnabled));
  // What the card shows, and the search the stays were read for.
  const [form, setForm] = useState(initial);
  const [search, setSearch] = useState(initial);
  const [answer, setAnswer] = useState<{ search: AgencySearch; prices: AgencyStayPrices } | null>(
    null,
  );
  const [searching, setSearching] = useState(true);
  const [failure, setFailure] = useState<{
    search: AgencySearch;
    kind: "busy" | "failed";
  } | null>(null);
  const [formError, setFormError] = useState("");
  const [sort, setSort] = useState(agency.results.defaultSort);
  const [filters, setFilters] = useState(NO_FILTERS);
  // A price range is in the display currency it was typed in: another currency starts without one.
  const [priceCurrency, setPriceCurrency] = useState(selectedCurrency);
  if (priceCurrency !== selectedCurrency) {
    setPriceCurrency(selectedCurrency);
    setFilters((current) => ({ ...current, price: { min: null, max: null } }));
  }
  // VAY-2460: the layout, on the agency's default each time; the map's stay under the mouse (from
  // either side) and the stay whose pill was clicked.
  const [chosenLayout, setLayout] = useState<AccountBookingPageLayout>(agency.layout.default);
  const [hovered, setHovered] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const wide = useWideScreen();
  // New filters start the map afresh: no stay stays lit or open that may have left the list.
  const changeFilters = (next: Filters) => {
    setFilters(next);
    setHovered(null);
    setPicked(null);
  };
  // VAY-2463: on a phone the filters are in a sheet the Filters button opens.
  const [sheetOpen, setSheetOpen] = useState(false);
  const filtersButton = useRef<HTMLButtonElement>(null);
  if (wide && sheetOpen) setSheetOpen(false);
  const closeSheet = () => {
    setSheetOpen(false);
    requestAnimationFrame(() => filtersButton.current?.focus());
  };
  // VAY-2463: a phone's map fills the screen, opened with the Map button over the list. The
  // agency's "Map" layout opens on it, behind "Show map" until the guest chose maps (VAY-2216);
  // "List + map" opens as the list. The Map button floats while the stays are on screen.
  const [phoneMapOpen, setPhoneMapOpen] = useState(agency.layout.default === "map");
  // A wide screen has its own layouts: the phone's map doesn't come back when it narrows again.
  if (wide && phoneMapOpen) setPhoneMapOpen(false);
  const mapButton = useRef<HTMLButtonElement>(null);
  const [staysSection, setStaysSection] = useState<HTMLElement | null>(null);
  const [staysOnScreen, setStaysOnScreen] = useState(false);
  useEffect(() => {
    if (!staysSection) return;
    const observer = new IntersectionObserver((entries) =>
      setStaysOnScreen(entries[entries.length - 1]!.isIntersecting),
    );
    observer.observe(staysSection);
    return () => observer.disconnect();
  }, [staysSection]);
  const closePhoneMap = () => {
    setPhoneMapOpen(false);
    setPicked(null);
    // The Map button floats only over the stays; at the top of the page, Filters is the nearest.
    requestAnimationFrame(() => (mapButton.current ?? filtersButton.current)?.focus());
  };
  const [panel, setPanel] = useState<SearchPanel>(null);
  const [promoInput, setPromoInput] = useState(initial.promoCode ?? "");
  // The search a newly applied code went out with, until its answer says whether a stay takes it.
  const [promoSearch, setPromoSearch] = useState<AgencySearch | null>(
    initial.promoCode ? initial : null,
  );
  const [appliedPromo, setAppliedPromo] = useState<string | null>(null);
  const [promoError, setPromoError] = useState("");
  const handled = useRef<object | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setSearching(true);
    setFailure(null);
    getAgencyStayPrices(agency.slug, search, controller.signal)
      .then((prices) => setAnswer({ search, prices }))
      .catch((error) => {
        if (controller.signal.aborted) return;
        // 503: the API is busy with other searches; 429: this guest searched a lot. Both pass.
        setFailure({
          search,
          kind:
            error instanceof ApiError && (error.status === 503 || error.status === 429)
              ? "busy"
              : "failed",
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false);
      });
    // The address keeps the search, for Back from a stay's page and for sharing.
    const params = new URLSearchParams(window.location.search);
    params.set("checkIn", search.checkIn);
    params.set("checkOut", search.checkOut);
    params.set("adults", String(search.adults));
    params.set("children", String(search.children));
    if (search.rooms > 1) params.set("rooms", String(search.rooms));
    else params.delete("rooms");
    if (search.promoCode) params.set("promoCode", search.promoCode);
    else params.delete("promoCode");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params}`);
    return () => controller.abort();
  }, [agency.slug, search]);

  // A code stays while some stay takes it for the search. Otherwise it leaves the search (and the
  // address) and the promo field says why.
  useEffect(() => {
    if (!answer || handled.current === answer) return;
    handled.current = answer;
    const sent = answer.search === promoSearch;
    if (sent) setPromoSearch(null);
    const code = answer.search.promoCode;
    if (code && answer.prices.stays.some((stay) => stay.price?.promoApplied)) {
      setAppliedPromo(code);
      if (sent) setPanel((open) => (open === "promo" ? null : open));
      return;
    }
    setAppliedPromo(null);
    if (!code) return;
    setPromoError(t("promoNoStay"));
    setForm((current) => (current.promoCode === code ? { ...current, promoCode: null } : current));
    const params = new URLSearchParams(window.location.search);
    params.delete("promoCode");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params}`);
  }, [answer, promoSearch, t]);

  /** Searches `next` (unless it is the search shown, which a failed search or `force` repeats)
   * and returns the search object sent. */
  const run = (
    next: AgencySearch,
    { scroll = true, force = false }: { scroll?: boolean; force?: boolean } = {},
  ): AgencySearch | null => {
    setForm(next);
    if (stayNights(next.checkIn, next.checkOut) > MAX_NIGHTS) {
      setFormError(t("tooLong", { count: MAX_NIGHTS }));
      return null;
    }
    setFormError("");
    if (scroll)
      document.getElementById("stays")?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (!force && !failure && sameSearch(next, search)) return null;
    const sent = { ...next };
    setSearch(sent);
    return sent;
  };
  const retry = () => {
    const sent = { ...search };
    if (promoSearch === search) setPromoSearch(sent);
    setSearch(sent);
  };
  // New dates search at once (the calendar closes with them); new guests once their panel closes.
  const changePanel = (next: SearchPanel) => {
    const party = (s: AgencySearch) => `${s.adults}/${s.children}/${s.rooms}`;
    if (panel === "guests" && next !== "guests" && party(form) !== party(search))
      run(form, { scroll: false });
    setPanel(next);
  };
  // The price filter works in the guest's display currency, as the cards show prices; a stay no
  // rate converts can't be compared (null).
  const priceValue = useCallback(
    (amount: number, currency: string) =>
      currency === selectedCurrency
        ? amount
        : (currency === baseCurrency || rates[currency]) &&
            (selectedCurrency === baseCurrency || rates[selectedCurrency])
          ? convertPrice(amount, currency)
          : null,
    [selectedCurrency, baseCurrency, rates, convertPrice],
  );
  const results = useMemo(
    () =>
      agencyResults(agency.stays, answer?.prices ?? null, sort, {
        badge: agency.results.lowestPriceBadge,
        // In the rates' own currency; null where no rate converts it.
        comparable: (amount, currency) =>
          currency === baseCurrency ? amount : rates[currency] ? amount / rates[currency] : null,
        filters,
        priceValue,
      }),
    [
      agency.stays,
      agency.results.lowestPriceBadge,
      answer,
      sort,
      baseCurrency,
      rates,
      filters,
      priceValue,
    ],
  );
  const filterOptions = useMemo(
    () =>
      agencyFilterOptions(
        agency.stays,
        answer?.prices ?? null,
        agency.filters,
        filters,
        priceValue,
      ),
    [agency.stays, agency.filters, answer, filters, priceValue],
  );
  const shown = answer?.search ?? search;
  const dates = formatStayRange(shown.checkIn, shown.checkOut, locale);
  const guests = (party: { adults: number; children: number }, rooms: number) => {
    const people =
      party.children > 0
        ? t("party", {
            adults: t("adults", { count: party.adults }),
            children: t("children", { count: party.children }),
          })
        : t("adults", { count: party.adults });
    return rooms > 1 ? t("inRooms", { guests: people, count: rooms }) : people;
  };
  const location =
    typeof window === "undefined"
      ? { protocol: "https:", host: "", pathname: "/" }
      : window.location;
  // A stay that takes no children is read (and opened) for the adults alone, as its page does.
  const adultsOnly = (card: AgencyCard) => shown.children > 0 && !card.stay.childrenEnabled;
  const text: AgencyCardText = {
    facts: (card) =>
      [
        t("facts", {
          count: card.price!.roomTypesFree,
          guests: guests(adultsOnly(card) ? { ...shown, children: 0 } : shown, card.price!.rooms),
        }),
        adultsOnly(card) && t("adultsOnly"),
      ]
        .filter(Boolean)
        .join(" · "),
    href: (card) =>
      stayHref(
        location,
        agency.slug,
        card.stay.slug,
        shown,
        card.price && {
          rooms: card.price.rooms,
          promoApplied: !!card.price.price?.promoApplied,
        },
      ),
  };
  // Maps need Google's key. A wide screen has the agency's layouts; a phone has the list and, when
  // the agency allows a map, the Map button for its full-screen map.
  const layouts: AccountBookingPageLayout[] = wide && MAPS_KEY ? agency.layout.allowed : ["list"];
  const layout = layouts.includes(chosenLayout) ? chosenLayout : "list";
  const phoneMap =
    !wide && !!MAPS_KEY && agency.layout.allowed.some((allowed) => allowed !== "list");
  const showChips = hasFilterChips(filterOptions);
  const activeFilters = activeFilterCount(filters);
  const filterChips = (sheet: boolean) => (
    <AgencyFilters
      options={filterOptions}
      filters={filters}
      onChange={changeFilters}
      typeLabel={(type) => stayTypeName(type, t)}
      currency={selectedCurrency}
      formatPrice={(value) =>
        new Intl.NumberFormat("en-GB", {
          style: "currency",
          currency: selectedCurrency,
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        }).format(value)
      }
      sheet={sheet}
    />
  );
  // A pill says the price per night in whole units, the guest's display currency first.
  const pinPrice = (card: AgencyCard) => {
    const price = card.price?.status === "available" ? card.price.price : null;
    return price
      ? (approximate(price.nightly, price.currency) ??
          new Intl.NumberFormat("en-GB", {
            style: "currency",
            currency: price.currency,
            maximumFractionDigits: 0,
          }).format(price.nightly))
      : null;
  };
  const mapProps = {
    stays: agency.stays,
    cards: results.cards,
    apiKey: MAPS_KEY,
    hovered,
    onHover: setHovered,
    picked,
    onPick: setPicked,
    price: pinPrice,
    typeName: (card: AgencyCard) =>
      card.stay.propertyType ? stayTypeName(card.stay.propertyType, t) : null,
    href: text.href,
  };
  const currencies = Array.from(
    new Set(
      answer?.prices.stays.flatMap((stay) => (stay.price ? [stay.price.currency] : [])) ?? [],
    ),
  );

  return (
    // Clipped, not hidden: a hidden overflow would stop the map next to the list from sticking.
    <div className="min-h-screen bg-white overflow-x-clip">
      <StayHero
        image={agency.header.imageUrl}
        alt={agency.page.title}
        heading={agency.page.title}
        subtext={agency.page.description}
        navigation={<BookingNavigation showGallery />}
      />

      <StaySearchCard
        stickyOnTablets={false}
        panel={panel}
        onPanel={changePanel}
        checkIn={form.checkIn}
        checkOut={form.checkOut}
        nights={stayNights(form.checkIn, form.checkOut)}
        onDates={(checkIn, checkOut) => run({ ...form, checkIn, checkOut }, { scroll: false })}
        adults={form.adults}
        childCount={form.children}
        guestsNote={th("roomsCount", { count: form.rooms })}
        guestsAside={th("roomsCount", { count: form.rooms })}
        guests={{
          childrenEnabled,
          onUpdate: (adults, children) =>
            setForm((current) => ({
              ...current,
              adults,
              children,
              rooms: Math.min(current.rooms, adults),
            })),
          rooms: {
            count: form.rooms,
            fewest: 1,
            onChange: (rooms) =>
              setForm((current) => ({
                ...current,
                rooms: Math.min(rooms, mostRooms(current.adults, 1)),
              })),
            // Who sleeps where is chosen on the stay's page.
            split: [],
            onSplit: () => undefined,
          },
        }}
        promo={
          <PromoField
            applied={appliedPromo ? { code: appliedPromo, discount: "" } : null}
            onRemove={() => {
              setAppliedPromo(null);
              setPromoInput("");
              setPromoError("");
              run({ ...form, promoCode: null }, { scroll: false });
            }}
            open={panel === "promo"}
            onOpen={() => changePanel("promo")}
            onClose={() => changePanel(null)}
            value={promoInput}
            onChange={(value) => {
              setPromoInput(value);
              setPromoError("");
            }}
            onApply={() => {
              const code = promoInput.trim();
              if (!code) return;
              setPromoError("");
              setPromoSearch(run({ ...form, promoCode: code }, { scroll: false, force: true }));
            }}
            loading={!!promoSearch && promoSearch === search && searching}
            error={promoError}
          />
        }
        onCheck={() => run(form)}
      />

      <section
        id="stays"
        ref={setStaysSection}
        aria-labelledby="stays-heading"
        className="mx-auto max-w-[1320px] scroll-mt-4 px-4 pb-16 pt-14 sm:px-6 lg:scroll-mt-36"
      >
        {/* On a phone (Timo's mobile prototype, VAY-2463) one slim row instead: how many stays
            are available, Sort by and the Filters button; the heading stays for screen readers.
            The count takes two lines before Sort and Filters move under it (a longer language,
            "Filters (2)"). */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 lg:gap-5">
          <h2
            id="stays-heading"
            className="sr-only font-heading text-3xl leading-tight text-gray-900 md:text-[44px] lg:not-sr-only"
          >
            {th("availableAccommodations")}
          </h2>
          <p
            role="status"
            data-testid="agency-count-short"
            className="flex-[1_1_4rem] text-[15px] leading-snug text-gray-500 lg:hidden"
          >
            {answer
              ? t("availableShort", { count: results.available })
              : t("checkingShort", { total: agency.stays.length })}
          </p>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <label className="flex items-center gap-2 text-[15px] text-gray-500">
              <svg
                aria-hidden="true"
                className="hidden h-4 w-4 lg:block"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4" />
              </svg>
              <span className="sr-only lg:not-sr-only">{t("sortBy")}</span>
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as AccountBookingPageSort)}
                className="min-h-[44px] cursor-pointer rounded-full border border-gray-200 bg-white px-3 text-[14px] font-semibold text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 lg:px-4 lg:text-[15px]"
              >
                {SORTS.map((key) => (
                  <option key={key} value={key}>
                    {t(`sort.${key}`)}
                  </option>
                ))}
              </select>
            </label>
            {showChips && (
              <button
                ref={filtersButton}
                type="button"
                aria-haspopup="dialog"
                aria-expanded={sheetOpen}
                onClick={() => setSheetOpen(true)}
                data-testid="agency-filters-button"
                className={`flex min-h-[44px] items-center gap-1.5 rounded-full border px-3.5 text-[14px] font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 lg:hidden ${
                  activeFilters
                    ? "border-primary-600 bg-primary-600 text-white"
                    : "border-gray-200 bg-white text-gray-900"
                }`}
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                >
                  <path d="M4 6h16M7 12h10M10 18h4" />
                </svg>
                {activeFilters ? t("filtersCount", { count: activeFilters }) : t("filters")}
              </button>
            )}
          </div>
        </div>

        <div className="mt-6 space-y-1.5">
          <p
            className="hidden text-[17px] text-gray-500 lg:block"
            role="status"
            data-testid="agency-count"
          >
            {answer
              ? t("count", {
                  available: results.available,
                  total: results.total,
                  dates,
                  guests: guests(shown, shown.rooms),
                })
              : t("checking", { total: agency.stays.length, dates })}
          </p>
          {answer && !answer.prices.childrenPriced && (
            <p className="text-sm text-gray-500">{t("childrenNote")}</p>
          )}
          {currencies.length === 1 ? (
            <ApproximateAmountsNote currency={currencies[0]!} />
          ) : (
            currencies.some((currency) => approximate(1_000_000, currency)) && (
              <p className="text-xs text-gray-500">{t("approximateMixed")}</p>
            )
          )}
        </div>

        {/* From `lg` up; a phone has the Filters button and its sheet. */}
        {(showChips || layouts.length > 1) && (
          <div className="mt-6 hidden flex-wrap items-center justify-between gap-3 border-b border-gray-200 pb-4 lg:flex">
            {showChips && filterChips(false)}
            {layouts.length > 1 && (
              <AgencyLayoutSwitch layouts={layouts} layout={layout} onChange={setLayout} />
            )}
          </div>
        )}

        {(formError || failure) && (
          <div
            role="alert"
            className="mt-6 flex flex-col gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 sm:flex-row sm:items-center sm:justify-between"
          >
            <p>{formError || t(failure!.kind)}</p>
            {!formError && (
              <button
                type="button"
                onClick={retry}
                className="min-h-[44px] shrink-0 rounded-full bg-primary-600 px-5 font-semibold text-white hover:bg-primary-700"
              >
                {t("retry")}
              </button>
            )}
          </div>
        )}

        {/* Not while full stays of the chosen kind are listed below (not on Map): some match. */}
        {answer &&
          filtersActive(filters) &&
          results.cards.length === 0 &&
          !(agency.results.showFullStays && results.full.length > 0 && layout !== "map") && (
            <p
              role="status"
              className="mt-6 rounded-[20px] border border-dashed border-gray-300 p-8 text-center text-base text-gray-500"
            >
              {t("noMatch")}{" "}
              <button
                type="button"
                onClick={() => changeFilters(NO_FILTERS)}
                className="min-h-[44px] font-semibold text-gray-900 underline hover:text-black"
              >
                {t("resetFilters")}
              </button>
            </p>
          )}

        {/* List + map: the list beside a map that stays in view while the page scrolls. */}
        <div className={`mt-6 ${layout === "split" ? "flex items-start gap-7" : ""}`}>
          {layout !== "map" && (
            <div className={layout === "split" ? "min-w-0 flex-[999_1_560px]" : ""}>
              <ul
                aria-busy={searching}
                data-testid="agency-stays"
                className={`grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-5 transition-opacity ${
                  searching && answer ? "opacity-60" : ""
                }`}
              >
                {results.cards.map((card) => (
                  <AgencyStayCard
                    key={card.stay.propertyId}
                    card={card}
                    text={text}
                    loading={!answer && searching}
                    highlighted={layout === "split" && hovered === card.stay.propertyId}
                    onHover={
                      layout === "split"
                        ? (on) =>
                            setHovered((current) =>
                              on
                                ? card.stay.propertyId
                                : current === card.stay.propertyId
                                  ? null
                                  : current,
                            )
                        : undefined
                    }
                  />
                ))}
              </ul>

              {agency.results.showFullStays && results.full.length > 0 && (
                <AgencyFullStays
                  dates={dates}
                  stays={results.full}
                  tooSmall={(price) => t("tooSmall", { guests: guests(shown, price.rooms) })}
                  onUse={(next) => run({ ...form, ...next })}
                />
              )}
            </div>
          )}
          {layout !== "list" && (
            <AgencyStayMap
              {...mapProps}
              compact={layout === "split"}
              className={
                layout === "split"
                  ? // Under the search card, which sticks to the top too (`top-4`, about 110 px).
                    "sticky top-36 h-[min(760px,calc(100vh-10rem))] min-w-0 flex-[1_1_380px]"
                  : "h-[720px]"
              }
            />
          )}
        </div>
      </section>

      {/* Not over the search card's open calendar, guests or promo field. */}
      {phoneMap && !phoneMapOpen && staysOnScreen && !sheetOpen && panel === null && (
        // Pressing it is the guest's choice to load Google (VAY-2216), remembered for this tab.
        <button
          ref={mapButton}
          type="button"
          onClick={() => {
            chooseMaps();
            setPhoneMapOpen(true);
          }}
          className="fixed bottom-7 left-1/2 z-40 inline-flex min-h-[50px] -translate-x-1/2 items-center gap-2 rounded-full bg-gray-900 px-6 text-base font-semibold text-white shadow-[0_8px_24px_rgba(0,0,0,0.25)] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
        >
          <svg
            aria-hidden="true"
            className="h-[18px] w-[18px]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" />
            <path d="M9 4v14M15 6v14" />
          </svg>
          {tm("viewMap")}
        </button>
      )}
      {phoneMap && phoneMapOpen && (
        <AgencyPhoneMap
          {...mapProps}
          title={t("mapSummary", { name: agency.page.title, count: results.cards.length })}
          summary={`${dates} · ${guests(shown, shown.rooms)}`}
          onClose={closePhoneMap}
        />
      )}

      {sheetOpen && (
        <AgencyFilterSheet
          count={answer ? results.cards.length : null}
          canReset={filtersActive(filters)}
          onReset={() => changeFilters(NO_FILTERS)}
          onClose={closeSheet}
        >
          {filterChips(true)}
        </AgencyFilterSheet>
      )}
    </div>
  );
}
