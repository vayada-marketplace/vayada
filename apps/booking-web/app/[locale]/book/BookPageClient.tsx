"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import BookShell from "./BookShell";
import ReplacementGuestRules from "@/components/booking/ReplacementGuestRules";
import ReplacementQuoteExtras from "@/components/booking/ReplacementQuoteExtras";
import { getReplacementAddons, type PricingAddon } from "@/services/api/replacementAddons";
import {
  buildReplacementAddonSelection,
  replacementExtrasScope,
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
import {
  bookEntry,
  bookStepQuery,
  bookSteps,
  parseBookStep,
  reachableStep,
  readBookFlowDraft,
  saveBookFlowDraft,
  type BookStep,
} from "@/lib/bookFlow";
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
  // The step is read from the URL (VAY-2195).
  return (
    <Suspense fallback={null}>
      <RoomQuoteForm key={slug} slug={slug} />
    </Suspense>
  );
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
  const [entry, setEntry] = useState<string | null>(null);
  // Set once the first page decided where a room card's hand-off opens.
  const handedOver = useRef(false);
  const [payment, setPayment] = useState<"" | PricingPaymentMethod>("");
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // VAY-2195: a refresh or Back keeps what this tab chose for the same hand-off.
    const handOff = bookEntry(window.location.search);
    setEntry(handOff);
    const draft = readBookFlowDraft(slug, handOff);
    if (draft) {
      setCheckIn(draft.checkIn);
      setCheckOut(draft.checkOut);
      setPromoCode(draft.promoCode);
      setChoices(draft.choices);
      setAllocationRevision(draft.allocationRevision);
      setExtras(draft.extras);
      setPayment(draft.payment);
      return;
    }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [pagePayment, setPagePayment] = useState<BookingPagePayment>({
    methods: ["card", "pay_at_property"],
    earliestArrival: {},
    termsText: null,
  });
  const [pagePaymentLoaded, setPagePaymentLoaded] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void getBookingPagePayment(slug, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setPagePayment(value);
        setPagePaymentLoaded(true);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [slug]);
  // Bank transfer and PayPal need their payment deadline to end before check-in (VAY-2145).
  const paymentMethods = bookingPageMethodsForArrival(pagePayment, checkIn);
  const tooSoon = pagePayment.methods.filter((method) => !paymentMethods.includes(method));
  useEffect(() => {
    // A restored choice waits for the hotel's own methods before it is judged.
    if (!pagePaymentLoaded) return;
    setPayment((current) => (current && !paymentMethods.includes(current) ? "" : current));
    // paymentMethods is derived from these two.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagePayment, checkIn, pagePaymentLoaded]);
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
  // Until the guest picks how to pay, the price uses the first way the hotel offers, paying at
  // the hotel first (nothing is charged now); a way the rooms don't accept moves on to the next.
  const [fallback, setFallback] = useState(0);
  const defaultMethods = [...paymentMethods].sort(
    (a, b) => Number(b === "pay_at_property") - Number(a === "pay_at_property"),
  );
  const method = payment || (pagePaymentLoaded ? (defaultMethods[fallback] ?? "") : "");
  const baseRequest =
    rooms && method ? roomQuoteRequest(rooms, choices, checkIn, checkOut, method, promoCode) : null;
  const roomsComplete =
    !!rooms && !!roomQuoteRequest(rooms, choices, checkIn, checkOut, "card", promoCode);
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
  // Extras chosen for another stay or another list of extras (a restored draft, changed dates or
  // extras that can't load) can't be priced: they are cleared, so the step never gets stuck.
  useEffect(() => {
    if (!extras || !baseRequest || (addonCatalogue === null && !addonError)) return;
    if (
      extras.scope !==
      replacementExtrasScope(addonCatalogue ?? [], baseRequest.selection, allocationRevision)
    )
      setExtras(null);
  }, [extras, baseRequest, addonCatalogue, addonError, allocationRevision]);
  const changeChoices = (change: (current: RoomChoice[]) => RoomChoice[]) => {
    setChoices(change);
    setAllocationRevision((value) => value + 1);
    setExtras(null);
    setFallback(0);
  };
  const { quote, error, errorStatus, loading, submit } = useReplacementQuote(slug, request);
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

  // VAY-2195: the booking steps, `step` in the URL. A step only opens once the steps before it
  // are complete; until the catalogues are in, a later step waits.
  const router = useRouter();
  const wanted = parseBookStep(useSearchParams().get("step"));
  const extrasOffered =
    addonError ||
    (addonCatalogue ?? []).some(
      (addon) => !baseRequest || addon.currency === baseRequest.selection.currency,
    );
  const steps = bookSteps(extrasOffered);
  const settled =
    entry !== null &&
    pagePaymentLoaded &&
    (rooms !== null || catalogError) &&
    (addonCatalogue !== null || addonError);
  const step = settled
    ? reachableStep(wanted, steps, { rooms: roomsComplete, extras: addons !== null })
    : wanted;
  // The steps this tab moved forward from, so in-page Back returns through the browser history.
  const forwardFrom = useRef<BookStep[]>([]);
  const go = (next: BookStep, replace = false) => {
    const href = `/book?${bookStepQuery(window.location.search, next)}`;
    if (replace) return router.replace(href);
    if (steps.indexOf(next) > steps.indexOf(step)) forwardFrom.current.push(step);
    router.push(href);
  };
  const goBack = (target: BookStep) => {
    const from = forwardFrom.current;
    if (from[from.length - 1] !== target) return go(target);
    from.pop();
    router.back();
  };
  useEffect(() => {
    // The browser's own Back lands on a step this tab moved forward from.
    const from = forwardFrom.current;
    while (from.length && from[from.length - 1] === step) from.pop();
  }, [step]);
  const next = steps[steps.indexOf(step) + 1] ?? "payment";
  const previous = steps[steps.indexOf(step) - 1] ?? "rooms";
  useEffect(() => {
    if (settled && step !== wanted) go(step, true);
    // go reads the current URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, step, wanted]);
  // A room card's complete choice opens at the first step after the rooms.
  useEffect(() => {
    if (!settled || handedOver.current) return;
    handedOver.current = true;
    if (wanted === "rooms" && new URLSearchParams(window.location.search).get("offer"))
      if (roomsComplete) go(steps[1] ?? "payment", true);
    // Only the first settled render decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);
  useEffect(() => {
    if (entry === null) return;
    saveBookFlowDraft(slug, {
      version: 1,
      entry,
      checkIn,
      checkOut,
      promoCode,
      choices,
      allocationRevision,
      extras,
      payment,
    });
  }, [slug, entry, checkIn, checkOut, promoCode, choices, allocationRevision, extras, payment]);
  // After the rooms, the price follows every change; a refused way to pay moves to the next one.
  useEffect(() => {
    if (step === "rooms" || !request || quote || loading || error) return;
    const timer = setTimeout(submit, 400);
    return () => clearTimeout(timer);
    // submit belongs to this request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(request), step, quote, loading, error]);
  useEffect(() => {
    // Only a refusal of this price moves on; a failed request keeps the guest's default.
    const refused = !!errorStatus && errorStatus >= 400 && errorStatus < 500 && errorStatus !== 429;
    if (error && refused && !quote && !payment && fallback + 1 < defaultMethods.length)
      setFallback((value) => value + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);
  const stepButtons = (label: string, ready: boolean) => (
    <div className="flex items-center justify-between gap-4 pt-2">
      <button type="button" className="underline" onClick={() => goBack(previous)}>
        Back
      </button>
      <button type="button" className={button} disabled={!ready} onClick={() => go(next)}>
        {label}
      </button>
    </div>
  );
  const titles: Record<BookStep, string> = {
    rooms: "Choose rooms and get a price",
    extras: "Enhance your stay",
    payment: "Secure payment",
  };

  return (
    <BookShell steps={steps} current={step} title={titles[step]}>
      <div className="max-w-3xl space-y-6">
        {step !== "rooms" && !settled ? (
          <p role="status">Loading your booking…</p>
        ) : step !== "rooms" ? null : catalogError ? (
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
              if (roomsComplete && settled) go(next);
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
                                  {
                                    checkIn,
                                    timezone: hotel?.timezone,
                                    formatDate: (date) => date,
                                  },
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
            <label className="block">
              Promo code (optional)
              <input
                className={field}
                value={promoCode}
                maxLength={200}
                onChange={(event) => setPromoCode(event.target.value)}
              />
            </label>
            <p className="text-sm text-gray-600">
              We’ll check the price for your choices next. All rooms must use the same currency.
            </p>
            <button className={button} type="submit" disabled={!roomsComplete || !settled}>
              Continue
            </button>
            {!roomsComplete && (
              <p className="text-sm text-gray-600">
                Choose dates, at least one room, adults and every child’s age.
              </p>
            )}
          </form>
        )}
        {settled && step === "extras" && (
          <>
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
            ) : (
              <ReplacementQuoteExtras
                catalogue={addonCatalogue ?? []}
                selection={baseRequest?.selection ?? null}
                allocationRevision={allocationRevision}
                value={extras}
                onChange={setExtras}
              />
            )}
            <p role="status">
              {quote
                ? `Your stay with extras: ${chargedMoney(quote.totalMinor, quote.currency)}`
                : loading
                  ? "Checking price…"
                  : ""}
            </p>
            {stepButtons("Continue to payment", addons !== null)}
          </>
        )}
        {settled && step === "payment" && (
          <>
            <button type="button" className="underline" onClick={() => goBack(previous)}>
              Back
            </button>
            <label className="block">
              Payment preference
              <select
                className={field}
                required
                value={method}
                onChange={(event) => setPayment(event.target.value as typeof payment)}
              >
                {!method && <option value="">Choose a payment method</option>}
                {paymentMethods.map((value) => (
                  <option key={value} value={value}>
                    {bookingPagePaymentMethodLabels[value]}
                  </option>
                ))}
              </select>
            </label>
            {tooSoon.length > 0 && (
              <p className="text-sm text-gray-600">
                {tooSoon.map((value) => bookingPagePaymentMethodLabels[value]).join(" and ")}{" "}
                {tooSoon.length > 1 ? "aren’t" : "isn’t"} available this close to check-in.
              </p>
            )}
            {loading && <p role="status">Checking price…</p>}
            {error && quote && (
              <p role="alert">
                {error}{" "}
                <button className="underline" onClick={submit}>
                  Get an updated price
                </button>
              </p>
            )}
          </>
        )}
        {step !== "rooms" && error && !quote && (
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
        {settled && step === "payment" && quote && (
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
      </div>
    </BookShell>
  );
}
