"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import StayHero from "@/components/booking/StayHero";
import StaySearchCard, { type SearchPanel } from "@/components/booking/StaySearchCard";
import PromoField from "@/components/booking/PromoField";
import { useRouter } from "@/i18n/navigation";
import BookingNavigation from "@/components/layout/BookingNavigation";
import BookingFooter from "@/components/layout/BookingFooter";
import PublicStructuredData from "@/components/booking/PublicStructuredData";
import { useAgencyPage, useHotel, useSlug } from "@/contexts/HotelContext";
import AgencyOverview from "@/components/agency/AgencyOverview";
import { calculateNights, ensureMinOneNight } from "@/lib/utils";
import { trackEvent } from "@/services/api/tracking";
import { onAnalyticsAllowed } from "@/services/api/analyticsConsent";
import { hotelService } from "@/services/api/hotel";
import { useStayRooms } from "@/lib/hooks/useStayRooms";
import StayRooms from "@/components/booking/StayRooms";
import Toast from "@/components/booking/Toast";
import RoomsLocationMap from "@/components/booking/RoomsLocationMap";

interface AppliedPromo {
  code: string;
  discountType: string;
  discountValue: number;
}

function HomePageContent() {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("home");
  const tc = useTranslations("common");
  const { hotel } = useHotel();
  const { slug } = useSlug();
  const searchParams = useSearchParams();

  useEffect(() => {
    trackEvent(slug, "page_visit", {});
    // VAY-2197: a first visit starts before the guest answers; "Allow" starts it then.
    return onAnalyticsAllowed(slug, () => trackEvent(slug, "page_visit", {}));
  }, [slug]);

  // Initialize from URL params so back-navigation from /book preserves the
  // user's selected dates and guests. Sanitize so a same-day or invalid range
  // from the URL never lands the page on "0 nights".
  const initialDates = (() => {
    const ciQ = searchParams.get("checkIn");
    const coQ = searchParams.get("checkOut");
    const today = new Date();
    const defaultCheckIn = (() => {
      const d = new Date(today);
      d.setDate(d.getDate() + 1);
      return d.toISOString().split("T")[0];
    })();
    const defaultCheckOut = (() => {
      const d = new Date(today);
      d.setDate(d.getDate() + 2);
      return d.toISOString().split("T")[0];
    })();
    return ensureMinOneNight(ciQ || defaultCheckIn, coQ || defaultCheckOut);
  })();
  const [checkIn, setCheckIn] = useState(initialDates.checkIn);
  const [checkOut, setCheckOut] = useState(initialDates.checkOut);
  const [adults, setAdults] = useState(() => parseInt(searchParams.get("adults") || "2"));
  const [children, setChildren] = useState(() => parseInt(searchParams.get("children") || "0"));
  const guestTypeSettings = hotel?.guestTypeSettings ?? {
    adultAgeThreshold: 18,
    childrenEnabled: true,
  };
  const effectiveChildren = guestTypeSettings.childrenEnabled ? children : 0;

  // The search card's open panel (dates, guests or promo).
  const [panel, setPanel] = useState<SearchPanel>(null);
  const [promoCode, setPromoCode] = useState("");
  const [appliedPromo, setAppliedPromo] = useState<AppliedPromo | null>(null);
  const [promoLoading, setPromoLoading] = useState(false);
  const [promoError, setPromoError] = useState("");
  const promoCodesEnabled = hotel?.promoCodesEnabled !== false;
  // VAY-2320: a promo the guest applied comes back with the search (Back from /book, "Change
  // rooms"), checked like a typed one, so the rooms chosen with it stay chosen.
  useEffect(() => {
    const code = searchParams.get("promoCode");
    if (!code || !slug) return;
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
    // Once per visit, from the URL it came with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const nights = calculateNights(checkIn, checkOut);
  // VAY-2461: the rooms, their prices and the group's choices, shared with the agency's stay page.
  const stayRooms = useStayRooms({
    slug,
    hotel,
    checkIn,
    checkOut,
    adults,
    children: effectiveChildren,
    promoCode: appliedPromo?.code ?? null,
    book: (search) => router.push(`/book${search}`),
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
    mapProperty,
    mapsKey,
    severalPlaces,
    requestDetails,
    toast,
    setToast,
  } = stayRooms;
  // "Who sleeps where" lives in the guests picker, above the cards.
  const openGuests = () => {
    setPanel("guests");
    document.getElementById("stay-search")?.scrollIntoView({ block: "start" });
  };
  // Back to the search, with the dates open and focused.
  const editDates = () => {
    setPanel("calendar");
    const search = document.getElementById("stay-search");
    search?.scrollIntoView({ block: "start" });
    search?.querySelector("button")?.focus({ preventScroll: true });
  };

  const heroImage = hotel.heroImage;
  const heroHeading = hotel.branding?.heroHeading || hotel.name;
  const heroSubtext = hotel.branding?.heroSubtext || hotel.description;

  return (
    <div className="min-h-screen bg-white overflow-x-hidden">
      <PublicStructuredData hotel={hotel} rooms={[]} locale={locale} />

      <StayHero
        image={heroImage}
        alt={hotel.name}
        heading={heroHeading}
        subtext={heroSubtext}
        navigation={<BookingNavigation showGallery />}
      />

      <StaySearchCard
        panel={panel}
        onPanel={setPanel}
        checkIn={checkIn}
        checkOut={checkOut}
        nights={nights}
        onDates={(ci, co) => {
          setCheckIn(ci);
          setCheckOut(co);
        }}
        adults={adults}
        childCount={effectiveChildren}
        guestsNote={pickMode ? t("roomsCount", { count: roomCount }) : tc("guests")}
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
          // VAY-2200: no promo field while the hotel has Promos off or no live code.
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
              onChange={(v) => {
                setPromoCode(v);
                setPromoError("");
              }}
              onApply={async () => {
                if (!promoCode.trim() || !slug) return;
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
                  } else {
                    setPromoError(result.message);
                  }
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
          // The cards already show this stay; without them, try loading them again.
          if (roomsFailed) reloadCatalog();
          document.getElementById("rooms")?.scrollIntoView({ behavior: "smooth" });
        }}
      />

      {/* Main Content */}
      <StayRooms model={stayRooms} onEditDates={editDates} onEditGuests={openGuests} />

      {mapProperty && rooms?.length && !severalPlaces ? (
        <RoomsLocationMap
          slug={slug}
          rooms={rooms}
          property={mapProperty}
          apiKey={mapsKey}
          onViewDetails={requestDetails}
        />
      ) : null}

      <BookingFooter />
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}

export default function HomePage() {
  // VAY-2459: an agency's address shows its stays.
  const { agency } = useAgencyPage();
  return (
    <Suspense fallback={<div className="min-h-screen bg-white" />}>
      {agency ? <AgencyOverview agency={agency} /> : <HomePageContent />}
    </Suspense>
  );
}
