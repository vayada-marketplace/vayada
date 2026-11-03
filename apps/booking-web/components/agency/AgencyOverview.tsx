"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { AccountBookingPageSort } from "@vayada/domain-booking/account-booking-page";
import StayHero from "@/components/booking/StayHero";
import StaySearchCard, { type SearchPanel } from "@/components/booking/StaySearchCard";
import PromoField from "@/components/booking/PromoField";
import ApproximateAmountsNote from "@/components/booking/ApproximateAmountsNote";
import BookingNavigation from "@/components/layout/BookingNavigation";
import AgencyStayCard, { type AgencyCardText } from "@/components/agency/AgencyStayCard";
import AgencyFullStays from "@/components/agency/AgencyFullStays";
import { useCurrency } from "@/contexts/CurrencyContext";
import { ApiError } from "@/services/api/client";
import {
  getAgencyStayPrices,
  type AgencyPage,
  type AgencySearch,
  type AgencyStayPrices,
} from "@/services/api/agencyPage";
import { agencyResults, formatStayRange, stayHref, stayNights } from "@/lib/agencyOverview";
import { mostRooms } from "@/lib/roomPicker";
import { ensureMinOneNight } from "@/lib/utils";

/** The longest search the agency price read takes (VAY-2458 `AGENCY_MAX_NIGHTS`). */
const MAX_NIGHTS = 30;
const SORTS: AccountBookingPageSort[] = ["price_low", "price_high", "recommended"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  const locale = useLocale();
  const searchParams = useSearchParams();
  const { convertPrice } = useCurrency();
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
  const [panel, setPanel] = useState<SearchPanel>(null);
  const [promoInput, setPromoInput] = useState(initial.promoCode ?? "");
  // A code waiting for its first answer, then the one that applies to at least one stay.
  const [promoPending, setPromoPending] = useState(initial.promoCode);
  const [appliedPromo, setAppliedPromo] = useState<string | null>(null);
  const [promoError, setPromoError] = useState("");

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

  // A promo code is kept once some stay takes it for these dates.
  useEffect(() => {
    if (!promoPending) return;
    if (failure?.search.promoCode === promoPending) {
      setPromoPending(null);
      return;
    }
    if (answer?.search.promoCode !== promoPending) return;
    if (answer.prices.stays.some((stay) => stay.price?.promoApplied)) {
      setAppliedPromo(promoPending);
      setPanel((open) => (open === "promo" ? null : open));
    } else {
      setPromoError(t("promoNoStay"));
      setForm((current) => ({ ...current, promoCode: null }));
    }
    setPromoPending(null);
  }, [answer, failure, promoPending, t]);

  const run = (next: AgencySearch, scroll = true) => {
    setForm(next);
    if (stayNights(next.checkIn, next.checkOut) > MAX_NIGHTS) {
      setFormError(t("tooLong", { count: MAX_NIGHTS }));
      return;
    }
    setFormError("");
    setSearch({ ...next });
    if (scroll)
      document.getElementById("stays")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // New dates search at once (the calendar closes with them); new guests once their panel closes.
  const changePanel = (next: SearchPanel) => {
    const party = (s: AgencySearch) => `${s.adults}/${s.children}/${s.rooms}`;
    if (panel === "guests" && next !== "guests" && party(form) !== party(search)) run(form, false);
    setPanel(next);
  };
  const results = useMemo(
    () =>
      agencyResults(agency.stays, answer?.prices ?? null, sort, {
        badge: agency.results.lowestPriceBadge,
        comparable: convertPrice,
      }),
    [agency.stays, agency.results.lowestPriceBadge, answer, sort, convertPrice],
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
  const text: AgencyCardText = {
    facts: (price) =>
      t("facts", { count: price.roomTypesFree, guests: guests(shown, price.rooms) }),
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
  const anyCurrency = answer?.prices.stays.find((stay) => stay.price)?.price?.currency;

  return (
    <div className="min-h-screen bg-white overflow-x-hidden">
      <StayHero
        image={agency.header.imageUrl}
        alt={agency.name}
        heading={agency.page.title}
        subtext={agency.page.description}
        navigation={<BookingNavigation showGallery />}
      />

      <StaySearchCard
        panel={panel}
        onPanel={changePanel}
        checkIn={form.checkIn}
        checkOut={form.checkOut}
        nights={stayNights(form.checkIn, form.checkOut)}
        onDates={(checkIn, checkOut) => run({ ...form, checkIn, checkOut }, false)}
        adults={form.adults}
        childCount={form.children}
        guestsNote={th("roomsCount", { count: form.rooms })}
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
              run({ ...form, promoCode: null }, false);
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
              setPromoPending(code);
              run({ ...form, promoCode: code }, false);
            }}
            loading={!!promoPending && searching}
            error={promoError}
          />
        }
        onCheck={() => run(form)}
      />

      <section
        id="stays"
        aria-labelledby="stays-heading"
        className="mx-auto max-w-[1320px] scroll-mt-36 px-4 pb-16 pt-14 sm:px-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-5">
          <h2
            id="stays-heading"
            className="font-heading text-3xl leading-tight text-gray-900 md:text-[44px]"
          >
            {th("availableAccommodations")}
          </h2>
          <label className="flex items-center gap-2 text-[15px] text-gray-500">
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4" />
            </svg>
            {t("sortBy")}
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as AccountBookingPageSort)}
              className="min-h-[44px] cursor-pointer rounded-full border border-gray-200 bg-white px-4 text-[15px] font-semibold text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            >
              {SORTS.map((key) => (
                <option key={key} value={key}>
                  {t(`sort.${key}`)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-6 space-y-1.5">
          <p className="text-[17px] text-gray-500" role="status" data-testid="agency-count">
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
          {anyCurrency && <ApproximateAmountsNote currency={anyCurrency} />}
        </div>

        {(formError || failure) && (
          <div
            role="alert"
            className="mt-6 flex flex-col gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 sm:flex-row sm:items-center sm:justify-between"
          >
            <p>{formError || t(failure!.kind)}</p>
            {!formError && (
              <button
                type="button"
                onClick={() => setSearch({ ...search })}
                className="min-h-[44px] shrink-0 rounded-full bg-primary-600 px-5 font-semibold text-white hover:bg-primary-700"
              >
                {t("retry")}
              </button>
            )}
          </div>
        )}

        <ul
          aria-busy={searching}
          data-testid="agency-stays"
          className={`mt-6 grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-5 transition-opacity ${
            searching && answer ? "opacity-60" : ""
          }`}
        >
          {results.cards.map((card) => (
            <AgencyStayCard
              key={card.stay.propertyId}
              card={card}
              text={text}
              loading={!answer && searching}
            />
          ))}
        </ul>

        {agency.results.showFullStays && results.full.length > 0 && (
          <AgencyFullStays
            dates={dates}
            stays={results.full}
            tooSmall={(price) => t("tooSmall", { guests: guests(shown, price.rooms) })}
            onUse={(next) => run({ ...shown, ...next })}
          />
        )}
      </section>
    </div>
  );
}
