"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import ReplacementGuestRules from "@/components/booking/ReplacementGuestRules";
import ReplacementQuoteExtras from "@/components/booking/ReplacementQuoteExtras";
import { getReplacementAddons, type PricingAddon } from "@/services/api/replacementAddons";
import {
  buildReplacementAddonSelection,
  type ReplacementExtrasValue,
} from "@/services/api/replacementAddonSelection";
import ReplacementQuoteTerms from "@/components/booking/ReplacementQuoteTerms";
import type { QuoteTermsAcknowledgement } from "@/components/booking/ReplacementQuoteTerms";
import ReplacementBookingConfirmation from "@/components/booking/ReplacementBookingConfirmation";
import BookingPageTerms from "@/components/booking/BookingPageTerms";
import type {
  PricingPaymentMethod,
  PublicQuoteGuestDisclosure,
} from "@vayada/domain-booking/replacement-pricing";
import {
  bookingPageMethodsForArrival,
  bookingPagePaymentMethodLabels,
  getBookingPagePayment,
  type BookingPagePayment,
} from "@/services/api/bookingPagePaymentMethods";
import ApproximateAmountsNote from "@/components/booking/ApproximateAmountsNote";
import { useCurrency } from "@/contexts/CurrencyContext";
import { useHotel, useSlug } from "@/contexts/HotelContext";
import { choiceKeys, choiceText } from "@/lib/roomChoices";
import { useReplacementQuote } from "@/lib/hooks/useReplacementQuote";
import {
  displayQuoteMoney,
  getReplacementOffers,
  quoteMoneyAmount,
  roomQuoteRequest,
  type PricingRoom,
  type RoomChoice,
} from "@/services/api/replacementOffers";

const field = "block w-full rounded-lg border border-gray-300 p-3 mt-1 text-gray-900 bg-white";
const button = "rounded-full bg-primary-600 px-5 py-3 font-semibold text-white disabled:opacity-40";
const newRoom = (): RoomChoice => ({
  selectionId: crypto.randomUUID(),
  publicOfferKey: "",
  adults: "",
  childAges: [],
});

export default function BookPageClient() {
  const { slug } = useSlug();
  return <RoomQuoteForm key={slug} slug={slug} />;
}

function RoomQuoteForm({ slug }: { slug: string }) {
  const t = useTranslations("home");
  const { hotel } = useHotel();
  const [termsAcknowledgement, setTermsAcknowledgement] =
    useState<QuoteTermsAcknowledgement | null>(null);
  const [guestDisclosure, setGuestDisclosure] = useState<PublicQuoteGuestDisclosure | null>(null);
  const [guestRules, setGuestRules] = useState<PublicQuoteGuestDisclosure | null>(null);
  const [rooms, setRooms] = useState<PricingRoom[] | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [reload, setReload] = useState(0);
  const [extras, setExtras] = useState<ReplacementExtrasValue | null>(null);
  const [allocationRevision, setAllocationRevision] = useState(0);
  const [addonCatalogue, setAddonCatalogue] = useState<PricingAddon[] | null>(null);
  const [addonError, setAddonError] = useState(false);
  const [addonReload, setAddonReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setAddonCatalogue(null);
    setAddonError(false);
    void getReplacementAddons(slug, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setAddonCatalogue(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setAddonError(true);
      });
    return () => controller.abort();
  }, [slug, addonReload]);
  const [choices, setChoices] = useState<RoomChoice[]>([]);
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [promoCode, setPromoCode] = useState("");
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setCheckIn(params.get("checkIn") ?? "");
    setCheckOut(params.get("checkOut") ?? "");
    setPromoCode(params.get("promoCode") ?? "");
    // The hotel page hands over its party as a first room the guest can adjust or split;
    // child ages stay blank until chosen. A room card also hands over its choice and the rooms
    // the party needs (VAY-2190): adults spread evenly, children in the first room.
    const adults = Number(params.get("adults"));
    if (Number.isInteger(adults) && adults >= 1 && adults <= 99) {
      const children = Math.trunc(Number(params.get("children")) || 0);
      const childCount = Math.min(Math.max(children, 0), 99 - adults);
      const offer = params.get("offer") ?? "";
      const roomCount = Math.min(
        Math.max(Math.trunc(Number(params.get("rooms")) || 1), 1),
        adults,
        9,
      );
      setChoices(
        Array.from({ length: roomCount }, (_, index) => ({
          ...newRoom(),
          publicOfferKey: /^pricing-offer\.v2:[a-f0-9]{64}$/.test(offer) ? offer : "",
          adults: String(Math.floor(adults / roomCount) + (index < adults % roomCount ? 1 : 0)),
          childAges: index === 0 ? Array(childCount).fill("") : [],
        })),
      );
    }
  }, []);
  const [payment, setPayment] = useState<"" | PricingPaymentMethod>("");
  const [pagePayment, setPagePayment] = useState<BookingPagePayment>({
    methods: ["card", "pay_at_property"],
    earliestArrival: {},
    termsText: null,
  });
  useEffect(() => {
    const controller = new AbortController();
    void getBookingPagePayment(slug, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPagePayment(value);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [slug]);
  // Bank transfer and PayPal need their payment deadline to end before check-in (VAY-2145).
  const paymentMethods = bookingPageMethodsForArrival(pagePayment, checkIn);
  const tooSoon = pagePayment.methods.filter((method) => !paymentMethods.includes(method));
  useEffect(() => {
    setPayment((current) => (current && !paymentMethods.includes(current) ? "" : current));
    // paymentMethods is derived from these two.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagePayment, checkIn]);
  useEffect(() => {
    const controller = new AbortController();
    setRooms(null);
    setCatalogError(false);
    void getReplacementOffers(slug, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setRooms(value);
        // A choice handed over by a room card that is no longer offered is chosen again.
        const offered = new Set(value.flatMap(({ offers }) => offers.map((o) => o.publicOfferKey)));
        setChoices((current) =>
          current.map((choice) =>
            offered.has(choice.publicOfferKey) ? choice : { ...choice, publicOfferKey: "" },
          ),
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setCatalogError(true);
      });
    return () => controller.abort();
  }, [slug, reload]);
  const baseRequest =
    rooms && payment
      ? roomQuoteRequest(rooms, choices, checkIn, checkOut, payment, promoCode)
      : null;
  const addons = buildReplacementAddonSelection(
    addonCatalogue ?? [],
    baseRequest?.selection ?? null,
    allocationRevision,
    extras,
  );
  const request =
    baseRequest && addons !== null
      ? {
          ...baseRequest,
          selection: {
            ...baseRequest.selection,
            version: "public-pricing-selection.v2" as const,
            addons,
          },
        }
      : null;
  const changeChoices = (change: (current: RoomChoice[]) => RoomChoice[]) => {
    setChoices(change);
    setAllocationRevision((value) => value + 1);
    setExtras(null);
  };
  const { quote, error, loading, submit } = useReplacementQuote(slug, request);
  const { approximate } = useCurrency();
  // The charged amount in the quote currency, then any approximation in the guest's currency.
  const chargedMoney = (minor: string, currency: string) => {
    const approx = approximate(quoteMoneyAmount(minor, currency), currency);
    return `${displayQuoteMoney(minor, currency)}${approx ? ` (${approx})` : ""}`;
  };
  const update = (id: string, patch: Partial<RoomChoice>) =>
    changeChoices((current) =>
      current.map((choice) => (choice.selectionId === id ? { ...choice, ...patch } : choice)),
    );

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 space-y-6">
      <h1 className="text-3xl font-bold">Choose rooms and get a price</h1>
      <p className="text-gray-600">
        Tell us who will stay in each room. We’ll check the price for your dates and guests.
      </p>
      {catalogError ? (
        <div role="alert">
          We couldn’t load room options.{" "}
          <button className={button} onClick={() => setReload((value) => value + 1)}>
            Retry room options
          </button>
        </div>
      ) : rooms === null ? (
        <p role="status">Loading room options…</p>
      ) : rooms.length === 0 ? (
        <p role="status">Room options are currently unavailable.</p>
      ) : (
        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (request && !loading) submit();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label>
              Check-in
              <input
                className={field}
                type="date"
                required
                value={checkIn}
                onChange={(event) => setCheckIn(event.target.value)}
              />
            </label>
            <label>
              Check-out
              <input
                className={field}
                type="date"
                required
                value={checkOut}
                onChange={(event) => setCheckOut(event.target.value)}
              />
            </label>
          </div>
          {choices.map((choice, index) => (
            <fieldset
              key={choice.selectionId}
              className="rounded-xl border border-gray-200 p-5 space-y-4"
            >
              <legend className="font-semibold px-2">Room {index + 1}</legend>
              <label className="block">
                Room and meal option
                <select
                  className={field}
                  required
                  value={choice.publicOfferKey}
                  onChange={(event) =>
                    update(choice.selectionId, { publicOfferKey: event.target.value })
                  }
                >
                  <option value="">Choose an option</option>
                  {rooms.map((room) => {
                    // The plain names the room cards use: "Deluxe Double Room — Non-refundable".
                    const keys = choiceKeys(room.offers);
                    return (
                      <optgroup key={room.roomTypeId} label={room.name}>
                        {room.offers.map((offer, offerIndex) => (
                          <option key={offer.publicOfferKey} value={offer.publicOfferKey}>
                            {room.name} —{" "}
                            {
                              choiceText(
                                keys[offerIndex]!,
                                { checkIn, timezone: hotel?.timezone, formatDate: (date) => date },
                                t,
                              ).name
                            }
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                </select>
              </label>
              <label className="block">
                Adults (ages 18+)
                <input
                  className={field}
                  type="number"
                  min={1}
                  max={99}
                  step={1}
                  required
                  value={choice.adults}
                  onChange={(event) => update(choice.selectionId, { adults: event.target.value })}
                />
              </label>
              {choice.childAges.map((age, child) => (
                <div className="flex items-end gap-3" key={child}>
                  <label className="flex-1">
                    Child {child + 1}: age at check-in
                    <select
                      className={field}
                      required
                      value={age}
                      onChange={(event) =>
                        update(choice.selectionId, {
                          childAges: choice.childAges.map((value, position) =>
                            position === child ? event.target.value : value,
                          ),
                        })
                      }
                    >
                      <option value="">Choose age</option>
                      {Array.from({ length: 18 }, (_, value) => (
                        <option key={value} value={value}>
                          {value === 0 ? "Under 1" : value}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="p-3 underline"
                    aria-label={`Remove child ${child + 1} from room ${index + 1}`}
                    onClick={() =>
                      update(choice.selectionId, {
                        childAges: choice.childAges.filter((_, position) => position !== child),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div className="flex flex-wrap gap-4">
                <button
                  type="button"
                  className="underline"
                  disabled={choice.childAges.length + Number(choice.adults || 1) >= 99}
                  onClick={() =>
                    update(choice.selectionId, { childAges: [...choice.childAges, ""] })
                  }
                >
                  Add child to room {index + 1}
                </button>
                <button
                  type="button"
                  className="underline"
                  onClick={() =>
                    changeChoices((current) =>
                      current.filter((room) => room.selectionId !== choice.selectionId),
                    )
                  }
                >
                  Remove room {index + 1}
                </button>
              </div>
            </fieldset>
          ))}
          <button
            type="button"
            className={button}
            disabled={choices.length >= 99}
            onClick={() => changeChoices((current) => [...current, newRoom()])}
          >
            Add room
          </button>
          {addonError ? (
            <p role="alert">
              Extra options are unavailable.{" "}
              <button
                type="button"
                className="underline"
                onClick={() => setAddonReload((value) => value + 1)}
              >
                Retry extras
              </button>
            </p>
          ) : addonCatalogue === null ? (
            <p role="status">Loading optional extras…</p>
          ) : (
            <ReplacementQuoteExtras
              catalogue={addonCatalogue}
              selection={baseRequest?.selection ?? null}
              allocationRevision={allocationRevision}
              value={extras}
              onChange={setExtras}
            />
          )}
          <label className="block">
            Promo code (optional)
            <input
              className={field}
              value={promoCode}
              maxLength={200}
              onChange={(event) => setPromoCode(event.target.value)}
            />
          </label>
          <label className="block">
            Payment preference
            <select
              className={field}
              required
              value={payment}
              onChange={(event) => setPayment(event.target.value as typeof payment)}
            >
              <option value="">Choose a payment method</option>
              {paymentMethods.map((method) => (
                <option key={method} value={method}>
                  {bookingPagePaymentMethodLabels[method]}
                </option>
              ))}
            </select>
          </label>
          {tooSoon.length > 0 && (
            <p className="text-sm text-gray-600">
              {tooSoon.map((method) => bookingPagePaymentMethodLabels[method]).join(" and ")}{" "}
              {tooSoon.length > 1 ? "aren’t" : "isn’t"} available this close to check-in.
            </p>
          )}
          <p className="text-sm text-gray-600">
            We’ll check whether your choices and payment method are supported. All rooms must use
            the same currency.
          </p>
          <button className={button} type="submit" disabled={!request || loading}>
            {loading ? "Checking price…" : "Get price"}
          </button>
          {!request && (
            <p className="text-sm text-gray-600">
              Choose dates, at least one room, adults, every child’s age and a payment preference.
            </p>
          )}
        </form>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            className="underline"
            onClick={() => {
              changeChoices((current) =>
                current.map((choice) => ({ ...choice, publicOfferKey: "" })),
              );
              setReload((value) => value + 1);
            }}
          >
            Reload room options
          </button>
        </p>
      )}
      {quote && (
        <section
          aria-label="Your stay price"
          className="rounded-xl border border-gray-200 p-5 space-y-3"
        >
          <h2 className="text-xl font-semibold">Your stay price</h2>
          <p>
            {quote.checkIn} to {quote.checkOut}
          </p>
          <p className="text-2xl font-bold">
            Total: {chargedMoney(quote.totalMinor, quote.currency)}
          </p>
          <p>Due now: {chargedMoney(quote.dueNowMinor, quote.currency)}</p>
          <p>Due later: {chargedMoney(quote.dueLaterMinor, quote.currency)}</p>
          <ApproximateAmountsNote currency={quote.currency} />
          <ReplacementQuoteTerms
            quote={quote}
            onAcknowledgementChange={setTermsAcknowledgement}
            roomNames={Object.fromEntries(
              choices.map((choice) => [
                choice.selectionId,
                rooms?.find((room) =>
                  room.offers.some((offer) => offer.publicOfferKey === choice.publicOfferKey),
                )?.name ?? "",
              ]),
            )}
          />
          <ReplacementGuestRules
            key={quote.quoteId}
            slug={slug}
            quote={quote}
            onAcknowledgementChange={setGuestDisclosure}
            onRulesChange={setGuestRules}
          />
          {pagePayment.termsText && <BookingPageTerms text={pagePayment.termsText} />}
          <ReplacementBookingConfirmation
            key={quote.quoteId}
            slug={slug}
            quote={quote}
            disclosure={guestDisclosure}
            rules={guestRules?.quoteId === quote.quoteId ? guestRules.choices : null}
            termsAccepted={termsAcknowledgement?.quoteId === quote.quoteId}
            hotelTerms={pagePayment.termsText !== null}
          />
        </section>
      )}
    </main>
  );
}
