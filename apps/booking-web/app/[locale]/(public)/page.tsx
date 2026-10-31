"use client";

import { useState, useRef, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import HotelHeroImage from "@/components/booking/HotelHeroImage";
import { Link, useRouter } from "@/i18n/navigation";
import BookingNavigation from "@/components/layout/BookingNavigation";
import BookingFooter from "@/components/layout/BookingFooter";
import DatePickerCalendar from "@/components/booking/DatePickerCalendar";
import GuestSelector from "@/components/booking/GuestSelector";
import PublicStructuredData from "@/components/booking/PublicStructuredData";
import { useHotel, useSlug } from "@/contexts/HotelContext";
import { calculateNights, formatDateShort, formatDate, ensureMinOneNight } from "@/lib/utils";
import { trackEvent } from "@/services/api/tracking";
import { onAnalyticsAllowed } from "@/services/api/analyticsConsent";
import { hotelService } from "@/services/api/hotel";
import { useBookingSteps } from "@/lib/hooks/useBookingSteps";
import { useStayPrices } from "@/lib/hooks/useStayPrices";
import RoomCard from "@/components/booking/RoomCard";
import RoomTabs, { RoomsHelp, type RoomsProgressRoom } from "@/components/booking/RoomsProgress";
import Toast, { type ToastMessage } from "@/components/booking/Toast";
import {
  encodePick,
  evenSplit,
  fitsRoom,
  MAX_ROOMS,
  mostRooms,
  pickIdentity as stayIdentity,
  readPickDraft,
  takeRoomUndo,
  roomGuests,
  savePickDraft,
  type PickDraft,
  type RoomPick,
} from "@/lib/roomPicker";
import RoomsLocationMap, {
  useGuestPlaces,
  useLocationLine,
} from "@/components/booking/RoomsLocationMap";
import AccommodationViews from "@/components/booking/AccommodationViews";
import ApproximateAmountsNote from "@/components/booking/ApproximateAmountsNote";
import {
  getReplacementCatalog,
  quoteMoneyAmount,
  type CatalogLocationMap,
  type PricingRoom,
} from "@/services/api/replacementOffers";

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
  // VAY-2320: the rooms the group wants; null until the guest picks a number (then one).
  const [roomsWanted, setRoomsWanted] = useState<number | null>(() => {
    const value = Number(searchParams.get("rooms"));
    return Number.isInteger(value) && value >= 1 && value <= MAX_ROOMS ? value : null;
  });
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
  const { steps: STEPS, hasAddons } = useBookingSteps("rooms");

  // The legacy availability search is retired (VAY-1543 C.2): rooms, availability and
  // prices come from the room-and-price page, which starts from the stay chosen here.
  const bookParams = new URLSearchParams({ checkIn, checkOut, adults: String(adults) });
  if (effectiveChildren > 0) bookParams.set("children", String(effectiveChildren));
  if (appliedPromo) bookParams.set("promoCode", appliedPromo.code);
  const bookTarget = `/book?${bookParams}`;

  // Room cards (VAY-2190): the public catalog's rooms, priced for the stay above. Without the
  // catalog the page keeps the plain "Choose rooms and get a price" entry.
  const [rooms, setRooms] = useState<PricingRoom[] | null>(null);
  const [roomsFailed, setRoomsFailed] = useState(false);
  // The hotel's location map (VAY-2126), read live with the catalog; null while its switch is off.
  const [locationMap, setLocationMap] = useState<CatalogLocationMap | null>(null);
  // A map pin's "View details" opens that room card's details: one counter per room.
  const [detailsRequests, setDetailsRequests] = useState<Record<string, number>>({});
  useEffect(() => {
    const controller = new AbortController();
    getReplacementCatalog(slug, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setRooms(value.rooms);
        setLocationMap(value.locationMap);
      })
      .catch(() => {
        if (!controller.signal.aborted) setRoomsFailed(true);
      });
    return () => controller.abort();
  }, [slug]);
  // One room is chosen like before; with two or more the guest chooses room by room, each card
  // priced and sized for the room being chosen (VAY-2320). VAY-2393: a group starts in one room
  // even when no place fits it all; the page offers the fewest rooms it needs instead.
  const [fewestRooms, setFewestRooms] = useState(1);
  const roomCount = Math.min(roomsWanted ?? 1, mostRooms(Math.max(adults, 1), fewestRooms));
  const pickMode = roomCount > 1;
  // VAY-2393: the group's split and picks are kept per stay (dates and promo), so other guests or
  // rooms keep the rooms chosen; Back from /book and a refresh find them again.
  const pickIdentity = stayIdentity({
    checkIn,
    checkOut,
    promoCode: appliedPromo?.code ?? null,
  });
  const [pickState, setPickState] = useState<{ identity: string } & PickDraft>({
    identity: "",
    split: [],
    picks: [],
  });
  useEffect(() => {
    if (pickState.identity === pickIdentity) return;
    setPickState({
      identity: pickIdentity,
      ...(readPickDraft(slug, pickIdentity) ?? { split: [], picks: [] }),
    });
  }, [pickIdentity, pickState.identity, slug]);
  const draft: PickDraft =
    pickState.identity === pickIdentity ? pickState : { split: [], picks: [] };
  const saveDraft = (next: PickDraft) => {
    setPickState({ identity: pickIdentity, ...next });
    savePickDraft(slug, pickIdentity, next);
  };
  // "Who sleeps where": the group's own split while it fits these guests and rooms, else even.
  const split =
    draft.split.length === roomCount && draft.split.reduce((sum, n) => sum + n, 0) === adults
      ? draft.split
      : evenSplit(adults, roomCount);
  // Children where the guest put them while they still add up, else in the rooms with the fewest
  // adults.
  const placed =
    split === draft.split &&
    draft.children?.length === split.length &&
    draft.children.reduce((sum, n) => sum + n, 0) === effectiveChildren
      ? draft.children
      : null;
  const slots = placed
    ? split.map((roomAdults, index) => ({ adults: roomAdults, children: placed[index]! }))
    : roomGuests(split, effectiveChildren);
  const picks = Array.from({ length: roomCount }, (_, index) => draft.picks[index] ?? null);
  // A chosen room is done while its rate is still offered and it sleeps the room's guests; one
  // the split made too small is chosen again (VAY-2393).
  const pickedRoom = (pick: RoomPick | null) => {
    if (!pick) return null;
    const room = rooms?.find(({ roomTypeId }) => roomTypeId === pick.roomTypeId);
    return room?.offers.some((o) => o.publicOfferKey === pick.publicOfferKey) ? room : null;
  };
  const done = picks.map((pick, index) => {
    const room = pickedRoom(pick);
    return !!room && fitsRoom(room.occupancy, slots[index]!);
  });
  const firstOpen = done.indexOf(false);
  // VAY-2393: "Change" on the Extras step arrives with the room to open (`change=N`).
  const [changing, setChanging] = useState<number | null>(() => {
    const value = Number(searchParams.get("change"));
    return Number.isInteger(value) && value >= 1 && value <= MAX_ROOMS ? value - 1 : null;
  });
  // VAY-2393: every room chosen and none reopened (Back from the next step): nothing to pick.
  const allChosen = pickMode && firstOpen === -1 && (changing === null || changing >= roomCount);
  // The room the cards are sized and priced for; the last one while every room is chosen.
  const activeRoom =
    changing !== null && changing < roomCount
      ? changing
      : firstOpen === -1
        ? roomCount - 1
        : firstOpen;
  const [toast, setToast] = useState<ToastMessage | null>(null);
  // The stay an Undo from the Extras step was for: its promo is checked after arrival.
  const arrivalStay = useRef<string | null>(null);
  // Other dates or promo start other picks: an Undo from before them can't come back.
  useEffect(() => {
    if (pickIdentity === arrivalStay.current) return;
    arrivalStay.current = null;
    setToast(null);
  }, [pickIdentity]);
  // VAY-2393: a room removed on the Extras step that sent the guest back here (the place left was
  // too small) says so here, with Undo back to the Extras step as it was.
  useEffect(() => {
    const undo = takeRoomUndo(slug);
    if (!undo) return;
    arrivalStay.current = undo.identity;
    setToast({
      id: Date.now(),
      message: undo.message,
      duration: 6000,
      focusAction: undo.focusAction,
      action: {
        label: t("roomsProgress.undo"),
        onClick: () => {
          if (undo.hotel) savePickDraft(slug, undo.identity, undo.hotel);
          router.push(`/book${undo.bookSearch}`);
        },
      },
    });
    // Once per arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);
  const stay = useStayPrices(
    slug,
    rooms?.length
      ? {
          checkIn,
          checkOut,
          adults,
          children: effectiveChildren,
          promoCode: appliedPromo?.code ?? null,
          room: pickMode ? slots[activeRoom]! : { adults, children: effectiveChildren },
        }
      : null,
  );
  useEffect(() => {
    // null: no type is free for the group, so it isn't held to a minimum.
    const suggested = stay.prices?.suggestedRooms;
    if (suggested !== undefined) setFewestRooms(suggested ?? 1);
  }, [stay.prices?.suggestedRooms]);
  // VAY-2393: a group's address keeps the stay, guests and rooms, so a refresh keeps its rooms.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!pickMode && !params.has("rooms")) return;
    const wanted: Record<string, string | null> = {
      checkIn,
      checkOut,
      adults: String(adults),
      children: effectiveChildren > 0 ? String(effectiveChildren) : null,
      rooms: roomCount > 1 ? String(roomCount) : null,
    };
    for (const [name, value] of Object.entries(wanted))
      if (value === null) params.delete(name);
      else params.set(name, value);
    // The picks are kept per promo: an applied one stays in the address (removing it drops it).
    if (appliedPromo) params.set("promoCode", appliedPromo.code);
    // The room to open is read once; a refresh doesn't open it again.
    params.delete("change");
    const search = params.toString();
    if (search !== window.location.search.slice(1))
      window.history.replaceState(null, "", `${window.location.pathname}?${search}`);
  }, [checkIn, checkOut, adults, effectiveChildren, roomCount, pickMode, appliedPromo]);
  // Other guests or dates: the room the guest reopened closes again, so a room the new split
  // makes too small comes up first (VAY-2393).
  const guestsAndDates = JSON.stringify([adults, effectiveChildren, checkIn, checkOut]);
  const [lastGuestsAndDates, setLastGuestsAndDates] = useState(guestsAndDates);
  if (guestsAndDates !== lastGuestsAndDates) {
    setLastGuestsAndDates(guestsAndDates);
    setChanging(null);
  }
  const [sortOption, setSortOption] = useState("recommended");
  const roomPrices = (room: PricingRoom) =>
    stay.prices?.rooms.find(({ roomTypeId }) => roomTypeId === room.roomTypeId) ?? null;
  const cheapest = (room: PricingRoom) => {
    const totals = (roomPrices(room)?.offers ?? []).flatMap((offer) =>
      offer.status === "priced" ? [quoteMoneyAmount(offer.totalMinor, offer.currency)] : [],
    );
    return totals.length ? Math.min(...totals) : null;
  };
  // Rooms without a price for this stay sort last either way.
  const byPrice = (a: PricingRoom, b: PricingRoom, direction: 1 | -1) => {
    const [x, y] = [cheapest(a), cheapest(b)];
    return x === null || y === null ? Number(x === null) - Number(y === null) : (x - y) * direction;
  };
  // The group's other rooms (by number) that took a room type, for the room being chosen; all
  // of them while every room is chosen.
  const takenBy = (room: PricingRoom) =>
    picks.flatMap((pick, index) =>
      pick && (allChosen || index !== activeRoom) && pick.roomTypeId === room.roomTypeId
        ? [index + 1]
        : [],
    );
  // VAY-2393: back to one room after removing the others, the place kept is "Your choice".
  const kept = pickMode ? null : pickedRoom(draft.picks[0] ?? null);
  // VAY-2393, as Timo's prototype sorts: rooms that fit first, then those too small for the
  // room being chosen (or the whole party), those the group's other rooms used up, and sold out
  // last, including a too-small type with none free. One room: "Your choice" first while it
  // holds the whole party.
  const pickOrder = (room: PricingRoom) => {
    const prices = roomPrices(room);
    if (!prices) return 0;
    if (prices.availability === "sold_out" && (prices.roomCount !== null || prices.roomsFree === 0))
      return 4;
    if (kept?.roomTypeId === room.roomTypeId && prices.roomCount !== null) return -1;
    if (allChosen) return 1;
    // Used up by the group's other rooms says so before too small (the card's label too).
    if (pickMode && prices.roomsFree != null && prices.roomsFree - takenBy(room).length <= 0)
      return 3;
    return prices.roomCount === null ? 2 : 0;
  };
  const shownRooms = [...(rooms ?? [])].sort(
    (a, b) =>
      pickOrder(a) - pickOrder(b) ||
      (sortOption === "priceLow"
        ? byPrice(a, b, 1)
        : sortOption === "priceHigh"
          ? byPrice(a, b, -1)
          : sortOption === "roomSize"
            ? (b.size?.value ?? 0) - (a.size?.value ?? 0)
            : 0),
  );
  // Rooms in several places (VAY-2324, VAY-2325): the cards say where each one is, and the guest can see them on
  // a map next to the list (or full screen on a phone), which replaces the Location section below.
  const mapsKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() ?? "";
  const mapProperty = locationMap
    ? { name: hotel.name, locality: hotel.location, pin: locationMap.property }
    : null;
  const guestPlaces = useGuestPlaces(rooms ?? [], mapProperty);
  const severalPlaces = guestPlaces.pins.length > 1;
  const locationLine = useLocationLine(mapProperty, guestPlaces.pins);
  const roomsMap = severalPlaces && mapsKey ? { ...guestPlaces, apiKey: mapsKey } : null;
  const selectRoom = (publicOfferKey: string, roomCount: number) => {
    // A place chosen with one room ends any earlier "Your choice" (VAY-2393).
    if (draft.picks.length) saveDraft({ split: [], picks: [] });
    trackEvent(slug, "rate_selected", { entry: "room_card" });
    const params = new URLSearchParams(bookParams);
    params.set("offer", publicOfferKey);
    if (roomCount > 1) params.set("rooms", String(roomCount));
    router.push(`/book?${params}`);
  };
  const offerOf = (pick: RoomPick) =>
    pickedRoom(pick)?.offers.find((offer) => offer.publicOfferKey === pick.publicOfferKey);
  // Every room chosen: /book gets each room's rate and guests, and opens after the rooms.
  const continueWithRooms = (chosen: RoomPick[]) => {
    // This page's history entry keeps the search, so Back finds the chosen rooms again.
    const here = new URLSearchParams(bookParams);
    here.set("rooms", String(roomCount));
    window.history.replaceState(null, "", `${window.location.pathname}?${here}`);
    const params = new URLSearchParams(bookParams);
    params.set("rooms", String(roomCount));
    chosen.forEach((pick, index) =>
      params.append("pick", encodePick({ ...slots[index]!, publicOfferKey: pick.publicOfferKey })),
    );
    // One rate selection per booking, as from a single room card.
    trackEvent(slug, "rate_selected", { entry: "room_card" });
    router.push(`/book?${params}`);
  };
  // Back to the top of the room list, without animation for guests who asked for less motion.
  const toRoomList = () =>
    document.getElementById("rooms")?.scrollIntoView({
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  // Room by room: the card's rate becomes the active room's choice, replacing any earlier one;
  // then the next open room, or straight on once every room is chosen (VAY-2393).
  const chooseRoom = (room: PricingRoom, publicOfferKey: string) => {
    if (!room.offers.some((offer) => offer.publicOfferKey === publicOfferKey)) return;
    const next = [...picks];
    next[activeRoom] = { roomTypeId: room.roomTypeId, publicOfferKey };
    saveDraft({ split, picks: next, ...(placed && { children: placed }) });
    setChanging(null);
    const open = done.findIndex((isDone, index) => index !== activeRoom && !isDone);
    if (open === -1) return continueWithRooms(next as RoomPick[]);
    toRoomList();
    // Keyboard and screen-reader users continue at "Pick a place for…", not on a card that moved.
    requestAnimationFrame(() =>
      document.getElementById("rooms-progress-title")?.focus({ preventScroll: true }),
    );
    setToast({
      id: Date.now(),
      message: t("roomsProgress.chosen", {
        number: activeRoom + 1,
        name: room.name,
        next: open + 1,
      }),
    });
  };
  // Other rooms: an even split again, the first rooms' choices kept.
  const changeRoomCount = (count: number) => {
    setRoomsWanted(count);
    setChanging(null);
    saveDraft({ split: [], picks: draft.picks.slice(0, count) });
  };
  // VAY-2393: a pill's × removes its room; the adults spread evenly over the rooms left, and
  // Undo brings back the rooms, split and choices for 6 seconds.
  const removeRoom = (index: number, byKeyboard = false) => {
    const before = { count: roomCount, draft: { split: [...split], picks: [...picks] } };
    const count = roomCount - 1;
    setRoomsWanted(count);
    setChanging(null);
    saveDraft({ split: [], picks: picks.filter((_, position) => position !== index) });
    setToast({
      id: Date.now(),
      message:
        count === 1
          ? t("roomsProgress.removedToOne", { number: index + 1, adults })
          : t("roomsProgress.removed", { number: index + 1 }),
      action: {
        label: t("roomsProgress.undo"),
        onClick: () => {
          setRoomsWanted(before.count);
          setChanging(null);
          saveDraft(before.draft);
          requestAnimationFrame(() =>
            document.getElementById("rooms-progress-title")?.focus({ preventScroll: true }),
          );
        },
      },
      duration: 6000,
      focusAction: byKeyboard,
    });
  };
  // VAY-2393, one room: a place too small for the whole party becomes room 1 for the adults it
  // takes, and the rest pick room 2.
  const bookPart = (room: PricingRoom, publicOfferKey: string, partAdults: number) => {
    if (!room.offers.some((offer) => offer.publicOfferKey === publicOfferKey)) return;
    saveDraft({
      split: [partAdults, adults - partAdults],
      // The part was priced for its adults alone: every child goes with the rest.
      children: [0, effectiveChildren],
      picks: [{ roomTypeId: room.roomTypeId, publicOfferKey }],
    });
    setRoomsWanted(2);
    setChanging(null);
    toRoomList();
    requestAnimationFrame(() =>
      document.getElementById("rooms-progress-title")?.focus({ preventScroll: true }),
    );
    setToast({
      id: Date.now(),
      message: t("roomsProgress.partChosen", {
        name: room.name,
        count: partAdults,
        rest: adults + effectiveChildren - partAdults,
      }),
    });
  };
  // VAY-2393, one room: no free place holds the whole party (some is free, none fits), read from
  // this answer's own rooms; the fewest rooms it needs is a lower bound, at least 2.
  const noneFits =
    !pickMode &&
    adults > 1 &&
    !!stay.prices?.rooms.length &&
    stay.prices.rooms.every(
      (room) => room.roomCount === null || room.availability === "sold_out",
    ) &&
    stay.prices.rooms.some((room) => room.roomCount === null && room.roomsFree !== 0);
  const roomsNeeded = Math.min(Math.max(2, fewestRooms), mostRooms(adults, fewestRooms));
  // A pill opens its room again; its choice stays until another one replaces it. Pressing the
  // reopened room's pill again keeps its choice and closes it.
  const openRoom = (index: number) => {
    if (index === activeRoom && changing !== null) return setChanging(null);
    setChanging(index);
    toRoomList();
  };
  // Arriving from the Extras step to change a room: straight to the room cards.
  useEffect(() => {
    if (searchParams.get("change")) toRoomList();
    // Once per arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // VAY-2422: a room button on the hotel's website links here with `room=<roomTypeId>`. Once
  // the rooms are in: straight to the room cards, with that room's details open.
  const linkedRoom = useRef(searchParams.get("room"));
  useEffect(() => {
    const roomTypeId = linkedRoom.current;
    if (!roomTypeId || !rooms?.some((room) => room.roomTypeId === roomTypeId)) return;
    linkedRoom.current = null;
    toRoomList();
    setDetailsRequests((requests) => ({
      ...requests,
      [roomTypeId]: (requests[roomTypeId] ?? 0) + 1,
    }));
    // Once, when the rooms arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms]);
  const progressRooms: RoomsProgressRoom[] = picks.map((pick, index) => {
    const room = pickedRoom(pick);
    return !room
      ? { state: "open" }
      : done[index]
        ? { state: "done", name: room.name }
        : { state: "too_small", name: room.name };
  });
  // "Who sleeps where" lives in the guests picker, above the cards.
  const openGuests = () => {
    setCalendarOpen(false);
    setGuestsOpen(true);
    document.getElementById("stay-search")?.scrollIntoView({ block: "start" });
  };
  // VAY-2412: a borderless select, labelled "Sort rooms" behind its icon.
  const sortControl = (
    <div className="flex items-center gap-1.5">
      <label htmlFor="room-sort" className="text-gray-400">
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
            d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
          />
        </svg>
        <span className="sr-only">{t("sortRooms")}</span>
      </label>
      <select
        id="room-sort"
        value={sortOption}
        onChange={(event) => setSortOption(event.target.value)}
        className="min-h-[44px] cursor-pointer bg-transparent text-sm font-medium text-gray-700"
      >
        <option value="recommended">{t("recommended")}</option>
        <option value="priceLow">{t("priceLowHigh")}</option>
        <option value="priceHigh">{t("priceHighLow")}</option>
        <option value="roomSize">{t("roomSize")}</option>
      </select>
    </div>
  );
  const roomCard = (
    room: PricingRoom,
    view: { compact: boolean; active: boolean; onActivate?: () => void } = {
      compact: false,
      active: false,
    },
  ) => (
    <RoomCard
      key={room.roomTypeId}
      room={room}
      prices={roomPrices(room)}
      pricesState={
        stay.failed ? "failed" : stay.missing ? "missing" : stay.loading ? "loading" : "ready"
      }
      checkIn={checkIn}
      nights={nights}
      timezone={hotel.timezone}
      childGuests={effectiveChildren}
      promoCode={appliedPromo?.code ?? null}
      onSelect={(publicOfferKey, count) =>
        pickMode ? chooseRoom(room, publicOfferKey) : selectRoom(publicOfferKey, count)
      }
      pick={
        pickMode
          ? {
              room: activeRoom + 1,
              guests: slots[activeRoom]!,
              takenBy: takenBy(room),
              chosen: picks.flatMap((pick, index) => {
                const offer = pick && index !== activeRoom ? offerOf(pick) : undefined;
                return offer ? [offer] : [];
              }),
              current:
                !allChosen && picks[activeRoom]?.roomTypeId === room.roomTypeId
                  ? picks[activeRoom]!.publicOfferKey
                  : null,
              onChangeGuests: openGuests,
              allChosen,
            }
          : undefined
      }
      chosen={kept?.roomTypeId === room.roomTypeId ? draft.picks[0]!.publicOfferKey : null}
      bookPart={
        !pickMode && adults > 1
          ? {
              guests: adults + effectiveChildren,
              onBook: (publicOfferKey, partAdults) => bookPart(room, publicOfferKey, partAdults),
            }
          : undefined
      }
      onView={() => trackEvent(slug, "room_viewed", { roomTypeId: room.roomTypeId })}
      detailsRequest={detailsRequests[room.roomTypeId] ?? 0}
      place={mapProperty}
      locationLine={severalPlaces ? locationLine(room) : null}
      compact={view.compact}
      active={view.active}
      onActivate={view.onActivate}
    />
  );
  const notices = (
    <>
      {stay.failed && (
        <div role="alert" className="mb-5 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {t("pricesFailed")}{" "}
          <button type="button" className="font-semibold underline" onClick={stay.retry}>
            {t("retryPrices")}
          </button>
        </div>
      )}
      {pickMode ? (
        <RoomsHelp
          count={roomCount}
          current={allChosen ? null : activeRoom}
          guests={slots[activeRoom]!}
          hasExtras={hasAddons}
          onContinue={() => continueWithRooms(picks as RoomPick[])}
        />
      ) : noneFits ? (
        // VAY-2393: no place fits the whole party; the rooms it needs are one click away.
        <div
          role="note"
          data-testid="none-fits"
          className="mb-5 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm text-amber-900">
            <strong>{t("oneRoom.noneFits", { count: adults + effectiveChildren })}</strong>{" "}
            {t("oneRoom.splitHint")}
          </p>
          <button
            type="button"
            onClick={() => changeRoomCount(roomsNeeded)}
            className="min-h-[44px] shrink-0 rounded-full bg-primary-600 px-5 text-sm font-semibold text-white hover:bg-primary-700"
          >
            {t("oneRoom.bookRooms", { count: roomsNeeded })}
          </button>
        </div>
      ) : (
        adults > 1 && (
          <p className="mb-5 text-sm text-gray-600">
            {t("oneRoom.together", { count: adults + effectiveChildren })}{" "}
            <button
              type="button"
              onClick={() => changeRoomCount(2)}
              className="font-semibold text-primary-600 underline"
            >
              {t("oneRoom.preferSeparate")}
            </button>
          </p>
        )
      )}
      {!pickMode && effectiveChildren > 0 && (
        <p className="mb-5 text-sm text-gray-500">{t("childrenPricedLater")}</p>
      )}
    </>
  );

  const heroImage = hotel.heroImage;
  const heroHeading = hotel.branding?.heroHeading || hotel.name;
  const heroSubtext = hotel.branding?.heroSubtext || hotel.description;

  return (
    <div className="min-h-screen bg-white overflow-x-hidden">
      <PublicStructuredData hotel={hotel} rooms={[]} locale={locale} />

      {/* Hero Section */}
      <div className="relative h-[520px] w-full">
        <HotelHeroImage src={heroImage} alt={hotel.name} quality={90} sizes="100vw" />
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-black/60" />

        <BookingNavigation showGallery />

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
      <div id="stay-search" className="sticky top-4 z-30 max-w-5xl mx-auto px-4 -mt-10">
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
                <p className="text-sm text-gray-500">
                  {pickMode ? t("roomsCount", { count: roomCount }) : tc("guests")}
                </p>
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
              rooms={
                rooms?.length
                  ? {
                      count: roomCount,
                      fewest: fewestRooms,
                      onChange: changeRoomCount,
                      split: slots,
                      onSplit: (next) => {
                        setChanging(null);
                        saveDraft({ split: next, picks });
                      },
                    }
                  : undefined
              }
            />
          </div>

          {/* VAY-2200: no promo field while the hotel has Promos off or no live code. */}
          {promoCodesEnabled && (
            <>
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
                        const params = new URLSearchParams(window.location.search);
                        if (params.has("promoCode")) {
                          params.delete("promoCode");
                          window.history.replaceState(
                            null,
                            "",
                            `${window.location.pathname}?${params}`,
                          );
                        }
                      }}
                      className="text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
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
                      <svg
                        className="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
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
            </>
          )}

          {/* Check Availability Button */}
          <button
            onClick={() => {
              setCalendarOpen(false);
              setGuestsOpen(false);
              setPromoOpen(false);
              // The cards already show this stay; without them, go straight to /book.
              if (rooms?.length)
                document.getElementById("rooms")?.scrollIntoView({ behavior: "smooth" });
              else router.push(bookTarget);
            }}
            className="w-full md:w-auto px-8 py-3 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors whitespace-nowrap flex items-center justify-center gap-2"
          >
            {tc("checkAvailability")}
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div id="rooms" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 scroll-mt-36">
        {/* Section Header + Step Indicator */}
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
          <div>
            <h2 className="text-2xl md:text-3xl font-heading text-gray-900">
              {t("availableAccommodations")}
            </h2>
            {/* VAY-2390: the cards lead with "≈" amounts in the guest's display currency. */}
            <ApproximateAmountsNote currency={hotel.currency} className="mt-2" />
          </div>

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

        {rooms === null && !roomsFailed ? (
          <div className="space-y-6" aria-hidden="true">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="bg-white border border-gray-200 rounded-2xl overflow-hidden animate-pulse flex flex-col md:flex-row"
              >
                <div className="w-full md:w-[420px] h-64 md:min-h-[320px] bg-gray-200" />
                <div className="flex-1 p-5 space-y-4">
                  <div className="h-6 bg-gray-200 rounded w-48" />
                  <div className="h-4 bg-gray-200 rounded w-32" />
                  <div className="h-16 bg-gray-200 rounded-xl" />
                  <div className="h-16 bg-gray-200 rounded-xl" />
                </div>
              </div>
            ))}
          </div>
        ) : rooms?.length ? (
          <>
            <AccommodationViews
              slug={slug}
              rooms={shownRooms}
              map={roomsMap}
              stay={{
                label: `${formatDateShort(checkIn, locale)} – ${formatDate(checkOut, locale)} · ${[
                  tc("adults", { count: adults }),
                  effectiveChildren > 0 && tc("children", { count: effectiveChildren }),
                ]
                  .filter(Boolean)
                  .join(", ")}`,
                // Back to the search, with the dates open and focused.
                onEdit: () => {
                  setGuestsOpen(false);
                  setCalendarOpen(true);
                  const search = document.getElementById("stay-search");
                  search?.scrollIntoView({ block: "start" });
                  search?.querySelector("button")?.focus({ preventScroll: true });
                },
              }}
              tabs={
                pickMode && (
                  <RoomTabs
                    rooms={progressRooms}
                    current={allChosen ? null : activeRoom}
                    guests={slots}
                    onOpen={openRoom}
                    onRemove={removeRoom}
                  />
                )
              }
              toolbar={sortControl}
              notices={notices}
              renderCard={roomCard}
            />
            {/* A group picks room by room above; the old room form is only the one-room fallback. */}
            {!pickMode && (
              <p className="mt-8 text-center text-gray-600">
                {t("severalRooms")}{" "}
                <Link href={bookTarget} className="font-semibold text-primary-600 underline">
                  {t("chooseRoomsAndPrice")}
                </Link>
              </p>
            )}
          </>
        ) : (
          /* Without room cards, rooms and prices live on the room-and-price page. */
          <Link
            href={bookTarget}
            className="inline-block mb-6 rounded-full bg-primary-600 px-6 py-3 font-semibold text-white"
          >
            {t("chooseRoomsAndPrice")}
          </Link>
        )}
      </div>

      {mapProperty && rooms?.length && !severalPlaces ? (
        <RoomsLocationMap
          slug={slug}
          rooms={rooms}
          property={mapProperty}
          apiKey={mapsKey}
          onViewDetails={(roomTypeId) =>
            setDetailsRequests((requests) => ({
              ...requests,
              [roomTypeId]: (requests[roomTypeId] ?? 0) + 1,
            }))
          }
        />
      ) : null}

      <BookingFooter />
      <Toast toast={toast} onClose={() => setToast(null)} />
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
