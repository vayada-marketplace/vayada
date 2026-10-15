"use client";

import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import BookShell from "./BookShell";
import ReplacementGuestRules from "@/components/booking/ReplacementGuestRules";
import ExtrasStep from "@/components/booking/ExtrasStep";
import DetailsStep, { rateTerms } from "@/components/booking/DetailsStep";
import PaymentStep from "@/components/booking/PaymentStep";
import StaySummary, { type SummaryRoom } from "@/components/booking/StaySummary";
import {
  acceptanceGuest,
  emptyGuest,
  guestComplete,
  phoneRequired,
  type GuestDetails,
} from "@/components/booking/GuestDetailsForm";
import { useQuoteGuestDisclosure } from "@/lib/hooks/useQuoteGuestDisclosure";
import { getReplacementAddons, type PricingAddon } from "@/services/api/replacementAddons";
import {
  buildReplacementAddonSelection,
  replacementExtrasScope,
  type ReplacementExtrasValue,
} from "@/services/api/replacementAddonSelection";
import ReplacementQuoteTerms from "@/components/booking/ReplacementQuoteTerms";
import type { QuoteTermsAcknowledgement } from "@/components/booking/ReplacementQuoteTerms";
import ReplacementBookingConfirmation, {
  type BookingAttempt,
} from "@/components/booking/ReplacementBookingConfirmation";
import type {
  PricingPaymentMethod,
  PublicBookingQuote,
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
  clearBookFlowDraft,
  type BookStep,
} from "@/lib/bookFlow";
import { useReplacementQuote } from "@/lib/hooks/useReplacementQuote";
import { serverNow } from "@/lib/serverClock";
import { bookingService } from "@/services/api/booking";
import {
  saveGuestDetails,
  saveLastBooking,
  toConfirmationBooking,
} from "@/lib/storage/bookingDraft";
import {
  getReplacementOffers,
  quoteMoneyAmount,
  roomQuoteRequest,
  type PricingRoom,
  type RoomChoice,
} from "@/services/api/replacementOffers";

const field = "block w-full rounded-lg border border-gray-300 p-3 mt-1 text-gray-900 bg-white";
const button = "rounded-full bg-primary-600 px-5 py-3 font-semibold text-white disabled:opacity-40";
/** "Fri, 6 Nov 2026" for a stay date (YYYY-MM-DD). */
const formatStayDate = (date: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })
    : date;
/** "Fri", "6 Nov" for a stay date (YYYY-MM-DD). */
const formatDay = (date: string) => {
  const day = new Date(`${date}T00:00:00Z`);
  return {
    weekday: day.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }),
    day: day.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }),
  };
};
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
  const [guest, setGuest] = useState<GuestDetails>(emptyGuest);
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
      setGuest(draft.guest);
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
    extras: {},
    groupExtras: true,
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
  // VAY-2200: without promo codes a code from an old link or draft is never sent.
  const promoCodesEnabled = hotel?.promoCodesEnabled !== false;
  const quotedPromoCode = promoCodesEnabled ? promoCode : "";
  const baseRequest =
    rooms && method
      ? roomQuoteRequest(rooms, choices, checkIn, checkOut, method, quotedPromoCode)
      : null;
  const roomsComplete =
    !!rooms && !!roomQuoteRequest(rooms, choices, checkIn, checkOut, "card", quotedPromoCode);
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
  const { formatPrice } = useCurrency();
  // The old pages' prices: the charged currency ("€410"), then any approximation.
  const money = (minor: string, currency: string) =>
    formatPrice(quoteMoneyAmount(minor, currency), currency);
  // An updated price for the same choices that differs from the one the guest saw says so.
  const requestIdentity = JSON.stringify(request);
  const shownQuote = useRef<{
    identity: string;
    quoteId: string;
    total: string;
    currency: string;
  } | null>(null);
  const [priceChange, setPriceChange] = useState<string | null>(null);
  // The last price for these choices: when an updated price is refused, the summary keeps it as
  // expired instead of disappearing.
  const [seenQuote, setSeenQuote] = useState<{ identity: string; quote: PublicBookingQuote }>();
  useEffect(() => {
    if (!quote) return;
    setSeenQuote({ identity: requestIdentity, quote });
    const before = shownQuote.current;
    if (before && before.quoteId !== quote.quoteId)
      setPriceChange(
        before.identity === requestIdentity && before.total !== quote.totalMinor
          ? money(before.total, before.currency)
          : null,
      );
    shownQuote.current = {
      identity: requestIdentity,
      quoteId: quote.quoteId,
      total: quote.totalMinor,
      currency: quote.currency,
    };
    // A new quote is the only change that matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote?.quoteId]);

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
  // The guest rules of the price on screen; the last ones known keep the details form steady while
  // a new price's rules load (VAY-2163).
  const guestRulesQuote = useQuoteGuestDisclosure(
    slug,
    wanted === "details" || wanted === "payment" ? quote : undefined,
  );
  const [knownRules, setKnownRules] = useState<PublicQuoteGuestDisclosure["choices"] | null>(null);
  useEffect(() => {
    if (guestRulesQuote.disclosure) setKnownRules(guestRulesQuote.disclosure.choices);
  }, [guestRulesQuote.disclosure]);
  const detailsComplete = guestComplete(guest, knownRules);
  // Booking sends the details under this price's own rules (the ticked ones, or as loaded);
  // until they are known the phone is required (VAY-2163).
  const rulesForQuote =
    (guestDisclosure?.quoteId === quote?.quoteId ? guestDisclosure?.choices : undefined) ??
    (guestRulesQuote.disclosure?.quoteId === quote?.quoteId
      ? guestRulesQuote.disclosure?.choices
      : undefined) ??
    null;
  // While the rules load (after a refresh), a blank phone doesn't send the guest back a step;
  // booking itself still waits for this price's rules.
  const detailsReady =
    detailsComplete ||
    (!knownRules &&
      guestComplete(guest, { phoneRequired: false } as PublicQuoteGuestDisclosure["choices"]));
  // A booking attempt whose outcome isn't known yet: the guest stays on the payment step with the
  // same price, way to pay and details until it is settled, so a retry can't book twice.
  const [attempt, setAttempt] = useState<BookingAttempt | null>(null);
  const attemptOpen = !!attempt;
  const settled =
    entry !== null &&
    pagePaymentLoaded &&
    (rooms !== null || catalogError) &&
    (addonCatalogue !== null || addonError);
  const step = settled
    ? reachableStep(wanted, steps, {
        rooms: roomsComplete,
        extras: addons !== null,
        details: detailsReady,
      })
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
    if (attemptOpen && wanted !== "payment") go("payment", true);
    else if (settled && step !== wanted) go(step, true);
    // go reads the current URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, step, wanted, attemptOpen]);
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
      guest,
    });
  }, [
    slug,
    entry,
    checkIn,
    checkOut,
    promoCode,
    choices,
    allocationRevision,
    extras,
    payment,
    guest,
  ]);
  // After the rooms, the price follows every change; a refused way to pay moves to the next one.
  useEffect(() => {
    if (step === "rooms" || !request || quote || loading || error) return;
    const timer = setTimeout(submit, 400);
    return () => clearTimeout(timer);
    // submit belongs to this request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(request), step, quote, loading, error]);
  // Only a refusal of this price moves on; a failed request can be tried again.
  const refused = !!errorStatus && errorStatus >= 400 && errorStatus < 500 && errorStatus !== 429;
  useEffect(() => {
    if (!error || !refused || quote) return;
    // A way to pay picked on Payment can only change there: before it, a refused one goes back
    // to the hotel's own order, starting with another way to pay.
    if (payment && step !== "payment") {
      setPayment("");
      setFallback(
        Math.max(
          0,
          defaultMethods.findIndex((value) => value !== payment),
        ),
      );
    } else if (!payment && fallback + 1 < defaultMethods.length) setFallback((value) => value + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);
  // A room card's hand-off goes back to the cards; the room form goes back to itself.
  const backToRooms = () => {
    const params = new URLSearchParams(window.location.search);
    if (!params.get("offer")) return goBack("rooms");
    const home = new URLSearchParams();
    for (const name of ["checkIn", "checkOut", "adults", "children", "promoCode"])
      if (params.get(name)) home.set(name, params.get(name)!);
    router.push(`/?${home}`);
  };
  const choiceName = (room: PricingRoom, publicOfferKey: string) => {
    const index = room.offers.findIndex((offer) => offer.publicOfferKey === publicOfferKey);
    return choiceText(
      choiceKeys(room.offers)[index]!,
      { checkIn, timezone: hotel?.timezone, formatDate: (date) => date },
      t,
    ).name;
  };
  const nights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000);
  const firstRoom = rooms?.find((room) =>
    room.offers.some((offer) => offer.publicOfferKey === choices[0]?.publicOfferKey),
  );
  const stayLine = [
    choices.length === 1 && firstRoom
      ? `${firstRoom.name} · ${choiceName(firstRoom, choices[0]!.publicOfferKey)}`
      : `${choices.length} rooms`,
    Number.isFinite(nights) ? `${nights} ${nights === 1 ? "night" : "nights"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const summaryRooms: SummaryRoom[] = choices.flatMap((choice) => {
    const room = rooms?.find((r) =>
      r.offers.some((o) => o.publicOfferKey === choice.publicOfferKey),
    );
    return room
      ? [
          {
            selectionId: choice.selectionId,
            name: room.name,
            choice: choiceName(room, choice.publicOfferKey),
            image: room.images?.[0]?.url,
          },
        ]
      : [];
  });
  const adultCount = choices.reduce((sum, choice) => sum + (Number(choice.adults) || 0), 0);
  const childCount = choices.reduce((sum, choice) => sum + choice.childAges.length, 0);
  const guestsLine = [
    `${adultCount} ${adultCount === 1 ? "adult" : "adults"}`,
    childCount ? `${childCount} ${childCount === 1 ? "child" : "children"}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const stayDates = [
    `${formatStayDate(checkIn)} – ${formatStayDate(checkOut)}`,
    Number.isFinite(nights) ? `${nights} ${nights === 1 ? "night" : "nights"}` : null,
    guestsLine,
  ]
    .filter(Boolean)
    .join(" · ");
  // VAY-2195: a made booking opens its confirmation page, as on the old pages. The page shows
  // what the server has for it; the room and extras names come from this booking.
  const openConfirmation = async ({
    bookingReference,
    requested,
    confirmationUrl,
  }: {
    bookingReference: string;
    requested: boolean;
    confirmationUrl?: string;
  }) => {
    // The steps are done: nothing of them is kept, so Back can't send them again.
    clearBookFlowDraft(slug);
    // A bank transfer or PayPal reservation has its own protected confirmation link.
    if (confirmationUrl) return router.replace(confirmationUrl);
    if (!quote) return;
    const chosen = (addonCatalogue ?? []).filter((addon) =>
      extras?.items.some((item) => item.id === addon.id),
    );
    const item = (id: string) => extras?.items.find((current) => current.id === id);
    const context = {
      hotelName: hotel.name,
      // Each kind of room once: the page puts "2×" in front when more rooms are booked.
      roomName: Array.from(
        new Set(summaryRooms.map((room) => `${room.name} · ${room.choice}`)),
      ).join(", "),
      guestFirstName: guest.firstName.trim(),
      guestLastName: guest.lastName.trim(),
      guestEmail: guest.email.trim().toLowerCase(),
      paymentMethod: quote.paymentMethod,
      addonIds: chosen.map((addon) => addon.id),
      addonNames: chosen.map((addon) => addon.name),
      addonQuantities: Object.fromEntries(
        chosen.map((addon) => [
          addon.id,
          item(addon.id)!.people.length || Number(item(addon.id)!.quantity) || 1,
        ]),
      ),
      addonDates: Object.fromEntries(chosen.map((addon) => [addon.id, item(addon.id)!.dates])),
    };
    // What the server has for the booking, if it answers quickly; otherwise what this booking knows.
    const answer = await Promise.race([
      bookingService.lookup(slug, bookingReference, context.guestEmail).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    const found = answer?.bookingReference === bookingReference ? answer : null;
    saveLastBooking(
      toConfirmationBooking(
        found ?? {
          bookingReference,
          checkIn: quote.checkIn,
          checkOut: quote.checkOut,
          currency: quote.currency,
          totalAmount: quoteMoneyAmount(quote.totalMinor, quote.currency),
          // As the server would answer: a card is paid when booked, or only held for a request,
          // and what isn't paid yet is still owed.
          paymentStatus:
            quote.paymentMethod === "card" ? (requested ? "authorized" : "paid") : "unpaid",
          balanceAmount: quoteMoneyAmount(
            requested ? quote.totalMinor : quote.dueLaterMinor,
            quote.currency,
          ),
          numberOfRooms: quote.rooms.length,
          adults: adultCount,
          children: childCount,
          status: requested ? "pending" : "confirmed",
        },
        context,
      ),
    );
    saveGuestDetails({
      roomTypeId: "",
      guestFirstName: context.guestFirstName,
      guestLastName: context.guestLastName,
      guestEmail: context.guestEmail,
      guestPhone: guest.phone.trim(),
    });
    router.replace(`/booking/${encodeURIComponent(bookingReference)}`);
  };
  const missingDay = (addonCatalogue ?? []).find((addon) =>
    extras?.items.some((item) => item.id === addon.id && item.dates.length === 0),
  )?.name;
  // Each step continues with a price: a refused one says so above the step's buttons.
  const priceFailed = !!error && !quote;
  // The last price for these choices stays in the summary, struck through, once it has run out.
  const summaryQuote =
    quote ??
    (priceFailed &&
    seenQuote?.identity === requestIdentity &&
    Date.parse(seenQuote.quote.expiresAt) <= serverNow()
      ? seenQuote.quote
      : undefined);
  const priceNotice = error && !quote && (
    <Notice
      tone="red"
      title={error}
      action={
        refused
          ? { label: "Choose another room", onClick: backToRooms }
          : { label: "Try again", onClick: submit }
      }
    >
      No booking was made and nothing was charged.
    </Notice>
  );
  const titles: Record<BookStep, string> = {
    rooms: "Choose rooms and get a price",
    extras: "Enhance Your Stay",
    details: "Guest Information",
    payment: "Secure Payment",
  };

  return (
    <BookShell
      steps={steps}
      current={step}
      title={titles[step]}
      subtitle={
        step === "extras"
          ? "Add extras to your stay. We include them in your price straight away."
          : undefined
      }
    >
      <div className={step === "rooms" ? "max-w-3xl space-y-6" : "space-y-6"}>
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
            {promoCodesEnabled && (
              <label className="block">
                Promo code (optional)
                <input
                  className={field}
                  value={promoCode}
                  maxLength={200}
                  onChange={(event) => setPromoCode(event.target.value)}
                />
              </label>
            )}
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
              <div
                role="alert"
                className="p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700"
              >
                <p className="font-semibold">We couldn’t load our extras right now.</p>
                <p className="mt-1">Your rooms are kept. You can continue without extras.</p>
                <button
                  type="button"
                  className="mt-3 rounded-lg bg-primary-600 px-4 py-2 font-semibold text-white"
                  onClick={() => setAddonReload((value) => value + 1)}
                >
                  Try again
                </button>
              </div>
            ) : (
              baseRequest && (
                <ExtrasStep
                  catalogue={addonCatalogue ?? []}
                  display={pagePayment.extras}
                  showCategories={pagePayment.groupExtras}
                  selection={baseRequest.selection}
                  allocationRevision={allocationRevision}
                  value={extras}
                  onChange={setExtras}
                  quote={quote}
                  priceFailed={priceFailed}
                  formatMoney={money}
                  formatDay={formatDay}
                />
              )
            )}
            {priceNotice}
            <div className="flex flex-col-reverse md:flex-row md:items-center justify-between gap-4 border-t border-gray-200 pt-6">
              <button
                type="button"
                className="text-sm font-medium text-gray-600 hover:text-gray-900 flex items-center gap-1"
                onClick={backToRooms}
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 19l-7-7 7-7"
                  />
                </svg>
                Back to rooms
              </button>
              <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-6">
                <div className="md:text-right">
                  <p className="text-xs text-gray-500">{stayLine}</p>
                  <p
                    role="status"
                    aria-label="Your stay total"
                    className={
                      quote || loading ? "text-lg font-bold text-gray-900" : "text-sm text-gray-600"
                    }
                  >
                    {quote
                      ? money(quote.totalMinor, quote.currency)
                      : loading
                        ? "Checking price…"
                        : missingDay
                          ? "Choose a day to see your total"
                          : ""}
                    {quote && (
                      <span className="text-xs font-normal text-gray-500">
                        {" "}
                        total, includes taxes &amp; fees
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex flex-col items-start md:items-end gap-1">
                  <button
                    type="button"
                    className={button}
                    disabled={addons === null || !quote}
                    onClick={() => go(next)}
                  >
                    {addonError ? "Continue without extras" : "Continue to your details"}
                  </button>
                  {missingDay && (
                    <p className="text-xs text-amber-700">
                      Choose a day for {missingDay}, or remove it.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
        {settled && step === "details" && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-6">
              <DetailsStep
                quote={quote}
                rooms={summaryRooms}
                stayLine={stayDates}
                formatMoney={money}
                guest={guest}
                onGuestChange={setGuest}
                disclosure={guestRulesQuote.disclosure}
                rulesFailed={guestRulesQuote.failed}
                onRetryRules={guestRulesQuote.retry}
                termsText={pagePayment.termsText}
                locked={attemptOpen}
                rules={knownRules}
              />
              {!quote && loading && <p role="status">Checking price…</p>}
              {priceNotice}
              <div className="flex items-center justify-between gap-4 pt-2">
                <button
                  type="button"
                  className="text-sm font-medium text-gray-600 hover:text-gray-900 flex items-center gap-1"
                  onClick={() => (previous === "rooms" ? backToRooms() : goBack(previous))}
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 19l-7-7 7-7"
                    />
                  </svg>
                  {previous === "extras" ? "Back to extras" : "Back to rooms"}
                </button>
                <button
                  type="button"
                  className={button}
                  disabled={!detailsComplete || !quote}
                  onClick={() => go(next)}
                >
                  Continue to payment
                </button>
              </div>
              {!detailsComplete && (
                <p className="text-sm text-gray-600 text-right">
                  Fill in your name, email{phoneRequired(knownRules) ? " and phone" : ""} to
                  continue.
                </p>
              )}
            </div>
            <div className="lg:col-span-1">
              {quote && (
                <StaySummary
                  title="Your Stay"
                  quote={quote}
                  rooms={summaryRooms}
                  guests={guestsLine}
                  rules={knownRules}
                  formatMoney={money}
                  formatDate={formatStayDate}
                />
              )}
            </div>
          </div>
        )}
        {settled && step === "payment" && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2">
              <PaymentStep
                guestName={`${guest.firstName} ${guest.lastName}`}
                guestEmail={guest.email}
                onChangeDetails={() => goBack("details")}
                method={method}
                available={paymentMethods}
                tooSoon={
                  tooSoon.length
                    ? `${tooSoon.map((value) => bookingPagePaymentMethodLabels[value]).join(" and ")} ${
                        tooSoon.length > 1 ? "aren’t" : "isn’t"
                      } available this close to check-in.`
                    : null
                }
                onMethod={setPayment}
                locked={attemptOpen}
                termsText={pagePayment.termsText}
                quote={quote}
                total={quote ? money(quote.totalMinor, quote.currency) : ""}
                notice={
                  error && quote && !attemptOpen ? (
                    <Notice
                      tone="amber"
                      title={error}
                      action={{ label: "Get an updated price", onClick: submit }}
                    >
                      Nothing was booked or charged. Your extras and details are kept.
                    </Notice>
                  ) : error && !attemptOpen ? (
                    priceNotice
                  ) : priceChange && quote ? (
                    <Notice
                      tone="amber"
                      title={`Your price changed from ${priceChange} to ${money(quote.totalMinor, quote.currency)}.`}
                    >
                      Please check it and tick both boxes again.
                    </Notice>
                  ) : loading ? (
                    <p role="status">Checking price…</p>
                  ) : null
                }
                acknowledgements={
                  quote && (
                    <>
                      <ReplacementQuoteTerms
                        compact
                        quote={quote}
                        onAcknowledgementChange={setTermsAcknowledgement}
                        roomNames={Object.fromEntries(
                          summaryRooms.map((room) => [room.selectionId, room.name]),
                        )}
                      />
                      <ReplacementGuestRules
                        key={quote.quoteId}
                        compact
                        slug={slug}
                        quote={quote}
                        onAcknowledgementChange={setGuestDisclosure}
                      />
                    </>
                  )
                }
                cancellation={
                  quote
                    ? Array.from(
                        new Set(
                          quote.rooms.map((room) =>
                            rateTerms(room)[1]!.replace(/^Cancellation: /, ""),
                          ),
                        ),
                      ).map((line) => line.charAt(0).toUpperCase() + line.slice(1))
                    : []
                }
                confirm={
                  quote && (
                    <ReplacementBookingConfirmation
                      key={quote.quoteId}
                      slug={slug}
                      quote={quote}
                      disclosure={guestDisclosure}
                      guest={
                        guestComplete(guest, rulesForQuote)
                          ? acceptanceGuest(guest, rulesForQuote)
                          : null
                      }
                      termsAccepted={termsAcknowledgement?.quoteId === quote.quoteId}
                      hotelTerms={pagePayment.termsText !== null}
                      attempt={attempt}
                      onAttemptChange={setAttempt}
                      onBooked={openConfirmation}
                    />
                  )
                }
                onBack={() => goBack("details")}
              />
            </div>
            <div className="lg:col-span-1 space-y-4">
              {summaryQuote && (
                <StaySummary
                  title="Order Summary"
                  quote={summaryQuote}
                  rooms={summaryRooms}
                  guests={guestsLine}
                  rules={knownRules}
                  formatMoney={money}
                  formatDate={formatStayDate}
                  payment
                  expired={!!error}
                />
              )}
              {summaryQuote && <ApproximateAmountsNote currency={summaryQuote.currency} />}
            </div>
          </div>
        )}
      </div>
    </BookShell>
  );
}

/** The old pages' notice boxes: amber for a price to refresh, red when nothing can be booked. */
function Notice({
  tone,
  title,
  children,
  action,
}: {
  tone: "amber" | "red";
  title: string;
  children?: ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div
      role="alert"
      className={`p-4 border rounded-xl text-sm ${
        tone === "amber"
          ? "bg-amber-50 border-amber-200 text-amber-800"
          : "bg-red-50 border-red-200 text-red-700"
      }`}
    >
      <p className="font-semibold">{title}</p>
      {children && <p className="mt-1">{children}</p>}
      {action && (
        <button
          type="button"
          className="mt-3 rounded-lg bg-primary-600 px-4 py-2 font-semibold text-white"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
