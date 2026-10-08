"use client";

import { useState, useRef, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import Image from "next/image";
import { Link, useRouter } from "@/i18n/navigation";
import BookingNavigation from "@/components/layout/BookingNavigation";
import BookingFooter from "@/components/layout/BookingFooter";
import DatePickerCalendar from "@/components/booking/DatePickerCalendar";
import GuestSelector from "@/components/booking/GuestSelector";
import Surroundings from "@/components/booking/Surroundings";
import PublicStructuredData from "@/components/booking/PublicStructuredData";
import PropertyGallery from "@/components/booking/PropertyGallery";
import { useHotel, useSlug } from "@/contexts/HotelContext";
import { calculateNights, formatDateShort, formatDate, ensureMinOneNight } from "@/lib/utils";
import { trackEvent } from "@/services/api/tracking";
import { hotelService } from "@/services/api/hotel";
import { useBookingSteps } from "@/lib/hooks/useBookingSteps";

interface AppliedPromo {
  code: string;
  discountType: string;
  discountValue: number;
}

function PromoPopover({
  open,
  onClose,
  value,
  onChange,
  onApply,
  loading,
  error,
  t,
}: {
  open: boolean;
  onClose: () => void;
  value: string;
  onChange: (v: string) => void;
  onApply: () => void;
  loading: boolean;
  error: string;
  t: (key: string) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-2 bg-white rounded-xl shadow-xl border border-gray-100 p-4 z-50 w-64"
    >
      <p className="text-sm font-semibold text-gray-900 mb-2.5">{t("promoTitle")}</p>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          placeholder={t("enterCode")}
          className="flex-1 min-w-0 px-3 py-1.5 rounded-full border border-gray-300 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
        />
        <button
          onClick={onApply}
          disabled={loading || !value.trim()}
          className="px-4 py-1.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors text-xs disabled:opacity-50"
        >
          {loading ? "..." : t("apply")}
        </button>
      </div>
      {error && <p className="text-[11px] text-red-500 mt-1.5">{error}</p>}
    </div>
  );
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
    trackEvent(slug, "page_visit");
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

  const currentStep = 1;
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [guestsOpen, setGuestsOpen] = useState(false);
  const [promoOpen, setPromoOpen] = useState(false);
  const [promoCode, setPromoCode] = useState("");
  const [appliedPromo, setAppliedPromo] = useState<AppliedPromo | null>(null);
  const [promoLoading, setPromoLoading] = useState(false);
  const [promoError, setPromoError] = useState("");

  const nights = calculateNights(checkIn, checkOut);
  const { steps: STEPS } = useBookingSteps("rooms");

  // The legacy availability search is retired (VAY-1543 C.2): rooms, availability and
  // prices come from the room-and-price page, which starts from the stay chosen here.
  const bookParams = new URLSearchParams({ checkIn, checkOut, adults: String(adults) });
  if (effectiveChildren > 0) bookParams.set("children", String(effectiveChildren));
  if (appliedPromo) bookParams.set("promoCode", appliedPromo.code);
  const bookTarget = `/book?${bookParams}`;

  const heroImage = hotel.heroImage;
  const heroHeading = hotel.branding?.heroHeading || hotel.name;
  const heroSubtext = hotel.branding?.heroSubtext || hotel.description;

  return (
    <div className="min-h-screen bg-white overflow-x-hidden">
      <PublicStructuredData hotel={hotel} rooms={[]} locale={locale} />

      {/* Hero Section */}
      <div className="relative h-[520px] w-full">
        <Image
          src={heroImage}
          alt={hotel.name}
          fill
          className="object-cover"
          priority
          quality={90}
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-black/60" />

        <BookingNavigation />

        <PropertyGallery hotelName={hotel.name} images={hotel.images} />

        {/* Hero Content */}
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">
          <h1 className="text-5xl md:text-6xl lg:text-7xl font-heading italic text-white mb-4">
            {heroHeading}
          </h1>
          <p className="text-white/90 text-lg md:text-xl max-w-2xl leading-relaxed">
            {heroSubtext}
          </p>
        </div>
      </div>

      {/* Search Bar — sticky on scroll */}
      <div className="sticky top-4 z-30 max-w-5xl mx-auto px-4 -mt-10">
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-4 md:p-6 flex flex-row flex-wrap items-center gap-4 md:gap-6">
          {/* Dates — clickable to open calendar */}
          <div className="relative flex-1 min-w-[120px]">
            <button
              onClick={() => {
                setCalendarOpen(!calendarOpen);
                setGuestsOpen(false);
              }}
              className="flex items-center gap-3 w-full text-left hover:bg-gray-50 rounded-xl p-1 -m-1 transition-colors"
            >
              <div className="w-10 h-10 rounded-full bg-primary-50 flex items-center justify-center flex-shrink-0">
                <svg
                  className="w-5 h-5 text-primary-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                  />
                </svg>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {t("yourStay")}
                </p>
                <p className="text-base font-semibold text-gray-900">
                  {formatDateShort(checkIn, locale)} — {formatDate(checkOut, locale)}
                </p>
                <p className="text-sm text-gray-500">{tc("nights", { count: nights })}</p>
              </div>
            </button>
            <DatePickerCalendar
              open={calendarOpen}
              onClose={() => setCalendarOpen(false)}
              checkIn={checkIn}
              checkOut={checkOut}
              onSelect={(ci, co) => {
                setCheckIn(ci);
                setCheckOut(co);
              }}
            />
          </div>

          {/* Divider */}
          <div className="w-px h-12 bg-gray-200" />

          {/* Guests — clickable to open selector */}
          <div className="relative w-auto min-w-[100px]">
            <button
              onClick={() => {
                setGuestsOpen(!guestsOpen);
                setCalendarOpen(false);
              }}
              className="flex items-center gap-3 w-full hover:bg-gray-50 rounded-xl p-1 -m-1 transition-colors"
            >
              <div className="hidden md:flex w-10 h-10 rounded-full bg-primary-50 items-center justify-center flex-shrink-0">
                <svg
                  className="w-5 h-5 text-primary-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              </div>
              <div className="text-left">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {tc("guests")}
                </p>
                <p className="text-base font-semibold text-gray-900 whitespace-nowrap">
                  {tc("adults", { count: adults })}
                  {effectiveChildren > 0 && `, ${tc("children", { count: effectiveChildren })}`}
                </p>
                <p className="text-sm text-gray-500">{tc("guests")}</p>
              </div>
            </button>
            <GuestSelector
              open={guestsOpen}
              onClose={() => setGuestsOpen(false)}
              adults={adults}
              childCount={effectiveChildren}
              adultAgeThreshold={guestTypeSettings.adultAgeThreshold}
              childrenEnabled={guestTypeSettings.childrenEnabled}
              onUpdate={(a, c) => {
                setAdults(a);
                setChildren(c);
              }}
            />
          </div>

          {/* Divider */}
          <div className="hidden md:block w-px h-12 bg-gray-200" />

          {/* Promo */}
          <div className="relative flex justify-center md:justify-start w-full md:w-auto">
            {appliedPromo ? (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-primary-50 text-primary-700 rounded-full text-xs font-semibold">
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  {appliedPromo.code}
                  {appliedPromo.discountType === "percentage"
                    ? ` (-${appliedPromo.discountValue}%)`
                    : ` (-${appliedPromo.discountValue})`}
                </span>
                <button
                  onClick={() => {
                    setAppliedPromo(null);
                    setPromoCode("");
                    setPromoError("");
                  }}
                  className="text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            ) : (
              <>
                <button
                  onClick={() => {
                    setPromoOpen(!promoOpen);
                    setCalendarOpen(false);
                    setGuestsOpen(false);
                  }}
                  className="flex items-center gap-2 text-gray-500 hover:text-primary-600 transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
                    />
                  </svg>
                  <span className="text-sm font-medium">{t("addPromo")}</span>
                </button>
                {promoOpen && (
                  <PromoPopover
                    open={promoOpen}
                    onClose={() => setPromoOpen(false)}
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
                          setPromoOpen(false);
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
                    t={t}
                  />
                )}
              </>
            )}
          </div>

          {/* Check Availability Button */}
          <button
            onClick={() => {
              setCalendarOpen(false);
              setGuestsOpen(false);
              setPromoOpen(false);
              router.push(bookTarget);
            }}
            className="w-full md:w-auto px-8 py-3 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors whitespace-nowrap flex items-center justify-center gap-2"
          >
            {tc("checkAvailability")}
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* Section Header + Step Indicator */}
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
          <h2 className="text-2xl md:text-3xl font-heading text-gray-900">
            {t("availableAccommodations")}
          </h2>

          {/* Step Indicator */}
          <div className="flex items-center gap-2">
            {STEPS.map((step, index) => (
              <div key={step.number} className="flex items-center">
                <div className="flex items-center gap-1.5">
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                      step.number === currentStep
                        ? "bg-primary-600 text-white"
                        : step.number < currentStep
                          ? "bg-success-500 text-white"
                          : "bg-gray-200 text-gray-500"
                    }`}
                  >
                    {step.number}
                  </div>
                  <span
                    className={`hidden md:inline text-sm font-medium ${
                      step.number === currentStep ? "text-gray-900" : "text-gray-400"
                    }`}
                  >
                    {step.label}
                  </span>
                </div>
                {index < STEPS.length - 1 && <div className="w-8 md:w-12 h-px bg-gray-300 mx-2" />}
              </div>
            ))}
          </div>
        </div>

        {/* Rooms, availability and prices live on the room-and-price page. */}
        <Link
          href={bookTarget}
          className="inline-block mb-6 rounded-full bg-primary-600 px-6 py-3 font-semibold text-white"
        >
          {t("chooseRoomsAndPrice")}
        </Link>
      </div>

      <Surroundings key={slug} slug={slug} locality={hotel.contact.address} />

      <BookingFooter />
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-white" />}>
      <HomePageContent />
    </Suspense>
  );
}
