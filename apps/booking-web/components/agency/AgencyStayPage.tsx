"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import StayHero from "@/components/booking/StayHero";
import StaySearchCard, { type SearchPanel } from "@/components/booking/StaySearchCard";
import PromoField from "@/components/booking/PromoField";
import StayRooms from "@/components/booking/StayRooms";
import PropertyGallery from "@/components/booking/PropertyGallery";
import Toast from "@/components/booking/Toast";
import BookingNavigation from "@/components/layout/BookingNavigation";
import { StayHotelProvider, useHotel, useSlug } from "@/contexts/HotelContext";
import { useCurrency } from "@/contexts/CurrencyContext";
import { useStayRooms, type StayRoomsModel } from "@/lib/hooks/useStayRooms";
import { overviewHref, stayCheckoutUrl, stayTypeName } from "@/lib/agencyOverview";
import { calculateNights, ensureMinOneNight } from "@/lib/utils";
import { hotelService } from "@/services/api/hotel";
import { quoteMoneyAmount } from "@/services/api/replacementOffers";
import type { AgencyPage, AgencyStay } from "@/services/api/agencyPage";

interface AppliedPromo {
  code: string;
  discountType: string;
  discountValue: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (daysFromToday: number) => {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/**
 * One stay of an agency's page on the agency's address (VAY-2461, Timo's desktop prototype): the
 * agency's header, the search card, a compact box for the stay ("← All stays", name, type, area
 * and what it has, Gallery), and the stay's rooms exactly as on its own page. A room chosen shows
 * a dark bar with the choice and its total; Continue opens the stay's own checkout, on the stay's
 * address, until checkout runs on the agency's (VAY-2462).
 */
export default function AgencyStayPage({ agency, stay }: { agency: AgencyPage; stay: AgencyStay }) {
  return (
    // Clipped, not hidden, as on the overview: a hidden overflow would stop sticky parts.
    <div className="min-h-screen bg-white overflow-x-clip">
      <StayHero
        image={agency.header.imageUrl}
        alt={agency.name}
        heading={agency.page.title}
        subtext={agency.page.description}
        navigation={<BookingNavigation showGallery />}
      />
      <StayHotelProvider slug={stay.slug}>
        <StayContent agency={agency} stay={stay} />
      </StayHotelProvider>
    </div>
  );
}

function StayContent({ agency, stay }: { agency: AgencyPage; stay: AgencyStay }) {
  const t = useTranslations("agency");
  const th = useTranslations("home");
  const tc = useTranslations("common");
  const { hotel } = useHotel();
  const { slug } = useSlug();
  const searchParams = useSearchParams();
  const { approximate } = useCurrency();

  // The agency's search, as its stay card linked here (`stayHref`), else tomorrow for one night.
  const [initialDates] = useState(() =>
    ensureMinOneNight(
      searchParams.get("checkIn") || localDate(1),
      searchParams.get("checkOut") || localDate(2),
    ),
  );
  const [checkIn, setCheckIn] = useState(initialDates.checkIn);
  const [checkOut, setCheckOut] = useState(initialDates.checkOut);
  const [adults, setAdults] = useState(() => parseInt(searchParams.get("adults") || "2"));
  const [children, setChildren] = useState(() => parseInt(searchParams.get("children") || "0"));
  const guestTypeSettings = hotel.guestTypeSettings ?? {
    adultAgeThreshold: 18,
    childrenEnabled: true,
  };
  const effectiveChildren = guestTypeSettings.childrenEnabled ? children : 0;
  const [panel, setPanel] = useState<SearchPanel>(null);
  const [promoCode, setPromoCode] = useState("");
  const [appliedPromo, setAppliedPromo] = useState<AppliedPromo | null>(null);
  const [promoLoading, setPromoLoading] = useState(false);
  const [promoError, setPromoError] = useState("");
  const promoCodesEnabled = hotel.promoCodesEnabled !== false;
  // A code the agency's search applied here comes along, checked as on the stay's own page.
  useEffect(() => {
    const code = searchParams.get("promoCode");
    if (!code) return;
    let live = true;
    setPromoCode(code);
    hotelService
      .validatePromoCode(slug, code, { checkIn: initialDates.checkIn || undefined })
      .then((result) => {
        if (live && result.valid)
          setAppliedPromo({
            code: result.code,
            discountType: result.discountType!,
            discountValue: result.discountValue!,
          });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // Once per visit, from the address it came with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // The choice to take to checkout ("?checkIn=…&offer=…"), shown in the bar until Continue.
  const [chosen, setChosen] = useState<string | null>(null);
  const model = useStayRooms({
    slug,
    hotel,
    checkIn,
    checkOut,
    adults,
    children: effectiveChildren,
    promoCode: appliedPromo?.code ?? null,
    book: setChosen,
  });
  const {
    rooms,
    roomsFailed,
    reloadCatalog,
    roomCount,
    fewestRooms,
    pickMode,
    slots,
    changeRoomCount,
    changeSplit,
    toast,
    setToast,
  } = model;
  // Another search makes the choice stale.
  const searchKey = JSON.stringify([checkIn, checkOut, adults, effectiveChildren, appliedPromo]);
  const [lastSearch, setLastSearch] = useState(searchKey);
  if (searchKey !== lastSearch) {
    setLastSearch(searchKey);
    setChosen(null);
  }
  const openGuests = () => {
    setPanel("guests");
    document.getElementById("stay-search")?.scrollIntoView({ block: "start" });
  };
  const editDates = () => {
    setPanel("calendar");
    const search = document.getElementById("stay-search");
    search?.scrollIntoView({ block: "start" });
    search?.querySelector("button")?.focus({ preventScroll: true });
  };
  const location =
    typeof window === "undefined"
      ? { protocol: "https:", host: "", pathname: "/" }
      : window.location;
  const search = new URLSearchParams({ checkIn, checkOut, adults: String(adults) });
  if (effectiveChildren > 0) search.set("children", String(effectiveChildren));
  if (roomCount > 1) search.set("rooms", String(roomCount));

  return (
    <>
      <StaySearchCard
        panel={panel}
        onPanel={setPanel}
        checkIn={checkIn}
        checkOut={checkOut}
        nights={calculateNights(checkIn, checkOut)}
        onDates={(ci, co) => {
          setCheckIn(ci);
          setCheckOut(co);
        }}
        adults={adults}
        childCount={effectiveChildren}
        guestsNote={pickMode ? th("roomsCount", { count: roomCount }) : tc("guests")}
        guests={{
          adultAgeThreshold: guestTypeSettings.adultAgeThreshold,
          childrenEnabled: guestTypeSettings.childrenEnabled,
          onUpdate: (a, c) => {
            setAdults(a);
            setChildren(c);
          },
          rooms: rooms?.length
            ? {
                count: roomCount,
                fewest: fewestRooms,
                onChange: changeRoomCount,
                split: slots,
                onSplit: changeSplit,
              }
            : undefined,
        }}
        promo={
          promoCodesEnabled && (
            <PromoField
              applied={
                appliedPromo && {
                  code: appliedPromo.code,
                  discount:
                    appliedPromo.discountType === "percentage"
                      ? ` (-${appliedPromo.discountValue}%)`
                      : ` (-${appliedPromo.discountValue})`,
                }
              }
              onRemove={() => {
                setAppliedPromo(null);
                setPromoCode("");
                setPromoError("");
                const params = new URLSearchParams(window.location.search);
                if (params.has("promoCode")) {
                  params.delete("promoCode");
                  window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
                }
              }}
              open={panel === "promo"}
              onOpen={() => setPanel("promo")}
              onClose={() => setPanel(null)}
              value={promoCode}
              onChange={(value) => {
                setPromoCode(value);
                setPromoError("");
              }}
              onApply={async () => {
                if (!promoCode.trim()) return;
                setPromoLoading(true);
                setPromoError("");
                try {
                  const result = await hotelService.validatePromoCode(slug, promoCode, {
                    checkIn: checkIn || undefined,
                  });
                  if (result.valid) {
                    setAppliedPromo({
                      code: result.code,
                      discountType: result.discountType!,
                      discountValue: result.discountValue!,
                    });
                    setPanel(null);
                  } else setPromoError(result.message);
                } catch {
                  setPromoError("Failed to validate promo code");
                } finally {
                  setPromoLoading(false);
                }
              }}
              loading={promoLoading}
              error={promoError}
            />
          )
        }
        onCheck={() => {
          if (roomsFailed) reloadCatalog();
          document.getElementById("rooms")?.scrollIntoView({ behavior: "smooth" });
        }}
      />

      <StayRooms
        model={model}
        onEditDates={editDates}
        onEditGuests={openGuests}
        heading={t("stayRooms")}
        intro={
          <StayBox
            stay={stay}
            back={overviewHref(location, agency.slug, `?${search}`)}
            hotelName={hotel.name}
          />
        }
      />

      {chosen && (
        <ChoiceBar
          stay={stay}
          model={model}
          chosen={chosen}
          approximate={approximate}
          href={stayCheckoutUrl(location, agency.slug, stay.slug, chosen)}
        />
      )}
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}

/** The stay at a glance (Timo's prototype): photo, back to all stays, name and type, area and
 * what it has, and its photos. */
function StayBox({ stay, back, hotelName }: { stay: AgencyStay; back: string; hotelName: string }) {
  const t = useTranslations("agency");
  const tg = useTranslations("home.gallery");
  const type = stay.propertyType ? stayTypeName(stay.propertyType, t) : null;
  const facts = [
    stay.area,
    stay.privatePool && t("privatePool"),
    stay.units !== null &&
      t(stay.propertyType === "villa" ? "villas" : "units", { count: stay.units }),
  ].filter(Boolean);
  return (
    <section
      aria-labelledby="stay-name"
      data-testid="agency-stay-box"
      className="mb-12 flex flex-wrap items-center gap-5 rounded-[20px] border border-gray-200 p-4"
    >
      <div className="relative h-[104px] w-[148px] shrink-0 overflow-hidden rounded-[14px] bg-gray-200">
        {stay.photoUrl && (
          <Image src={stay.photoUrl} alt="" fill sizes="148px" className="object-cover" />
        )}
      </div>
      <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1">
        <a
          href={back}
          className="flex min-h-[32px] items-center gap-1 self-start text-sm font-semibold text-gray-500 hover:text-gray-900"
        >
          <svg
            aria-hidden="true"
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
          {t("allStays")}
        </a>
        <div className="flex flex-wrap items-center gap-2.5">
          <h3 id="stay-name" className="text-2xl font-bold text-gray-900">
            {stay.name}
          </h3>
          {type && (
            <span className="rounded-full border border-gray-300 bg-gray-100 px-2.5 py-0.5 text-sm text-gray-700">
              {type}
            </span>
          )}
        </div>
        {facts.length > 0 && <p className="text-[15px] text-gray-500">{facts.join(" · ")}</p>}
      </div>
      <div className="flex items-center gap-2.5">
        <PropertyGallery
          hotelName={hotelName}
          images={stay.photos}
          outline
          label={`${tg("open")}: ${stay.name}`}
        />
      </div>
    </section>
  );
}

/** The choice made, with its total when the cards priced it, and Continue (Timo's dark bar). */
function ChoiceBar({
  stay,
  model,
  chosen,
  approximate,
  href,
}: {
  stay: AgencyStay;
  model: StayRoomsModel;
  chosen: string;
  approximate: (amount: number, currency: string) => string | null;
  href: string;
}) {
  const t = useTranslations("agency");
  const th = useTranslations("home");
  const tc = useTranslations("common");
  const params = new URLSearchParams(chosen);
  const offer = params.get("offer");
  const room = offer
    ? model.rooms?.find((one) => one.offers.some((rate) => rate.publicOfferKey === offer))
    : undefined;
  // One room: the rate's total as its card shows it. A group's rooms are priced on checkout.
  const priced = room
    ? model
        .roomPrices(room)
        ?.offers.find((rate) => rate.publicOfferKey === offer && rate.status === "priced")
    : undefined;
  const total =
    priced && priced.status === "priced"
      ? (() => {
          const amount = quoteMoneyAmount(priced.totalMinor, priced.currency);
          return (
            approximate(amount, priced.currency) ??
            new Intl.NumberFormat("en-GB", { style: "currency", currency: priced.currency }).format(
              amount,
            )
          );
        })()
      : null;
  const line = room
    ? room.name
    : model.picks
        .flatMap((pick, index) => {
          const picked = pick && model.rooms?.find((one) => one.roomTypeId === pick.roomTypeId);
          return picked ? [t("roomLine", { number: index + 1, name: picked.name })] : [];
        })
        .join(" · ");
  return (
    <div
      data-testid="agency-choice-bar"
      className="fixed inset-x-4 bottom-5 z-50 mx-auto flex max-w-[1320px] flex-wrap items-center justify-between gap-4 rounded-[20px] bg-gray-900 px-5 py-3.5 text-white shadow-[0_12px_32px_rgba(0,0,0,0.25)] sm:inset-x-6"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <strong className="text-base">{stay.name}</strong>
        {line && <span className="text-sm text-gray-300">{line}</span>}
      </div>
      <div className="flex items-center gap-4">
        {total && <strong className="text-lg">{total}</strong>}
        <a
          href={href}
          className="flex min-h-[48px] items-center rounded-full bg-white px-[22px] text-base font-semibold text-gray-900 hover:bg-gray-100"
        >
          {model.hasAddons ? th("roomsProgress.continueToExtras") : tc("continue")}
        </a>
      </div>
    </div>
  );
}
