"use client";

import { Fragment, useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  format,
  addDays,
  startOfDay,
  differenceInDays,
  parseISO,
  startOfMonth,
  endOfMonth,
  addMonths,
  subMonths,
  startOfWeek,
  endOfWeek,
} from "date-fns";
import {
  calendarService,
  CalendarData,
  CalendarRoom,
  CalendarBooking,
  CalendarBlock,
} from "@/services/calendar";
import type { PmsManualBookingCreateInput } from "@/services/api/pmsManualBookingClient";
import { ApiErrorResponse } from "@/services/api/client";
import BlockModal from "@/components/calendar/BlockModal";
import BlockDetailModal from "@/components/calendar/BlockDetailModal";
import RoomShuffleNotice from "@/components/calendar/RoomShuffleNotice";
import TargetManualBookingModal from "@/components/calendar/TargetManualBookingModal";
import BookingDetailModal from "@/components/calendar/BookingDetailModal";
import AwaitingPaymentCard from "@/components/calendar/AwaitingPaymentCard";
import MiniDatePicker from "@/components/calendar/MiniDatePicker";
import MobileCalendar, { calendarLaneTop } from "@/components/calendar/MobileCalendar";
import MonthView from "@/components/calendar/MonthView";
import ReorderStepper from "@/components/calendar/ReorderStepper";
import {
  calendarNightRates,
  calendarRateNames,
  cellPrice,
  nightTaken,
  pricingRoom,
} from "@/components/calendar/calendarPrices";
import NightPopover from "@/components/calendar/NightPopover";
import BookingPopover, { BlockPopover } from "@/components/calendar/BookingPopover";
import type { PopoverAnchor } from "@/components/calendar/CalendarPopover";
import { useShowPrices } from "@/components/calendar/useShowPrices";
import { usePropertyPrices } from "@/components/pricing/RoomsPrices";
import { useTranslation } from "@/lib/i18n";
import {
  groupRoomsByType,
  moveRoomType,
  moveRoomWithinType,
  orderRoomsByRoomType,
} from "@/lib/roomOrdering";
import { channexService } from "@/services/channex";
import { getChannelBarColor, normalizeChannelKey } from "@/lib/constants/statusStyles";
import {
  AWAITING_PAYMENT_BAR_CLASS,
  AWAITING_PAYMENT_BAR_STYLE,
  formatPaymentDeadline,
  useHotelTimeZone,
} from "@/lib/awaitingPayment";

const VIEW_DAYS = 21;
const VIEW_MODE_STORAGE_KEY = "pms.calendar.viewMode";
const MOBILE_CALENDAR_QUERY = "(max-width: 767px)";
const MANUAL_BOOKINGS_AVAILABLE = true;
type ViewMode = "timeline" | "month";

const CHANNEL_LEGEND_KEYS: Array<{
  key: string;
  labelKey: string;
  color?: string;
  logo?: string;
}> = [
  { key: "direct", labelKey: "calendar.channelDirect", logo: "/vayada-logo.png" },
  { key: "airbnb", labelKey: "calendar.channelAirbnb", logo: "/logos/airbnb.svg" },
  { key: "booking.com", labelKey: "calendar.channelBookingCom", logo: "/logos/booking.svg" },
  { key: "expedia", labelKey: "calendar.channelExpedia", logo: "/logos/expedia.svg" },
  { key: "other", labelKey: "calendar.channelOther", color: "bg-gray-500" },
];

// Legend entries that are always shown regardless of channel manager state.
const ALWAYS_SHOWN_LEGEND_KEYS = new Set(["direct", "other"]);

// Resolve a booking's raw `channel` to the legend key it should light
// up. Bookings can carry historical aliases (``booking_com`` /
// ``BookingCom`` / ``booking``); ``normalizeChannelKey`` collapses those
// onto the canonical ``booking.com``. Anything not in the legend
// (Agoda, Vrbo, …) falls back to the generic ``other`` row so the bar's
// color still has a label users can decode.
const LEGEND_KEYS = new Set(CHANNEL_LEGEND_KEYS.map((c) => c.key));
const normalizeBookingChannel = (channel?: string | null): string => {
  const key = normalizeChannelKey(channel);
  return LEGEND_KEYS.has(key) ? key : "other";
};

const anchorOf = (element: Element): PopoverAnchor => {
  const { left, right, top, bottom } = element.getBoundingClientRect();
  return { left, right, top, bottom };
};

const mergeRoomOrderIntent = (
  intended: CalendarRoom[],
  current: CalendarRoom[],
  roomTypeIds: string[],
): CalendarRoom[] => {
  const currentById = new Map(current.map((room) => [room.id, room]));
  const intendedIds = new Set(intended.map(({ id }) => id));
  const intendedTypeIds = groupRoomsByType(intended).map(({ roomTypeId }) => roomTypeId);
  return orderRoomsByRoomType(
    [
      ...intended.flatMap(({ id }) => (currentById.has(id) ? [currentById.get(id)!] : [])),
      ...current.filter(({ id }) => !intendedIds.has(id)),
    ],
    Array.from(new Set([...intendedTypeIds, ...roomTypeIds])),
  );
};

export default function CalendarPage() {
  const { locale, t } = useTranslation();
  const [viewMode, setViewMode] = useState<ViewMode>("timeline");
  const [startDate, setStartDate] = useState(() => startOfDay(new Date()));
  const [mobileMonth, setMobileMonth] = useState(() => startOfMonth(new Date()));
  const [isMobileViewport, setIsMobileViewport] = useState<boolean | null>(null);
  const [data, setData] = useState<CalendarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [showBlockModal, setShowBlockModal] = useState(false);
  const [showNewBookingModal, setShowNewBookingModal] = useState(false);
  const [bookingNotice, setBookingNotice] = useState("");
  const [roomShuffleNotice, setRoomShuffleNotice] = useState<{
    eventId: string;
    bookingCount: number;
  } | null>(null);
  const [selectedBooking, setSelectedBooking] = useState<CalendarBooking | null>(null);
  // VAY-2348: a booking waiting for its bank transfer opens its deadline card, not the room tools.
  const [awaitingBooking, setAwaitingBooking] = useState<CalendarBooking | null>(null);
  const hotelTimeZone = useHotelTimeZone();
  // VAY-2411: free nights show their cheapest rate from the published prices, unless this user turned it off.
  const [showPrices, setShowPrices] = useShowPrices();
  const { prices, error: pricesError } = usePropertyPrices();
  // VAY-2411: a timeline bar (with its anchor) opens the booking's popover; the month and mobile views open its
  // window as before.
  const [bookingPopover, setBookingPopover] = useState<{
    booking: CalendarBooking;
    anchor: PopoverAnchor;
  } | null>(null);
  const [blockPopover, setBlockPopover] = useState<{
    block: CalendarBlock;
    anchor: PopoverAnchor;
  } | null>(null);
  const openBooking = useCallback((booking: CalendarBooking, anchor?: PopoverAnchor) => {
    if (booking.status === "awaiting_payment") return setAwaitingBooking(booking);
    if (!anchor) return setSelectedBooking(booking);
    setPrefill(null);
    setBlockPopover(null);
    setBookingPopover({ booking, anchor });
  }, []);
  const openBlock = (block: CalendarBlock, anchor: PopoverAnchor) => {
    setPrefill(null);
    setBookingPopover(null);
    setBlockPopover({ block, anchor });
  };
  /** The bar's look and hover text: channel colour, or the striped "awaiting payment" hold. */
  const bookingBar = (b: CalendarBooking, extraTitle = "") => {
    const name = `${b.guestFirstName} ${b.guestLastName}`.trim();
    if (b.status !== "awaiting_payment")
      return {
        className: `text-white ${getChannelBarColor(b.channel)} hover:brightness-110`,
        style: undefined,
        title: `${name} (${b.status})${extraTitle}\n${b.checkIn} → ${b.checkOut}\nChannel: ${b.channel}`,
        label: name,
      };
    const deadline = b.paymentDeadlineAt
      ? `\n${t("bookings.payBy", { date: formatPaymentDeadline(b.paymentDeadlineAt, locale, hotelTimeZone) })}`
      : "";
    return {
      className: `${AWAITING_PAYMENT_BAR_CLASS} hover:brightness-95`,
      style: AWAITING_PAYMENT_BAR_STYLE,
      title: `${name} (${t("bookings.statusAwaitingPayment")})${extraTitle}\n${b.checkIn} → ${b.checkOut}${deadline}`,
      label: `${name} · ${t("calendar.awaitingPayment")}`,
    };
  };
  const [selectedBlock, setSelectedBlock] = useState<CalendarBlock | null>(null);
  // Mobile-only: the date range selected in MobileCalendar before opening
  // either modal. `startDate` and `endDate` follow the desktop convention
  // (endDate is exclusive checkout). Desktop uses `prefill` instead, which
  // also carries a `roomId`.
  const [mobilePrefill, setMobilePrefill] = useState<{
    startDate: string;
    endDate: string;
  } | null>(null);
  const [connectedChannelKeys, setConnectedChannelKeys] = useState<Set<string> | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Reorder mode state. When `reorderMode` is true, the Calendar header is
  // replaced with Cancel / Save order, the grid is rendered but not
  // interactive, and `localRooms` holds the in-progress order. `localRooms`
  // is null when not reordering — the grid then reads order from `data.rooms`.
  const [showRoomViewMenu, setShowRoomViewMenu] = useState(false);
  const [reorderMode, setReorderMode] = useState(false);
  const [localRooms, setLocalRooms] = useState<CalendarRoom[] | null>(null);
  const [reorderOrderVersion, setReorderOrderVersion] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const [roomOrderError, setRoomOrderError] = useState<string | null>(null);
  const [roomOrderNeedsRefresh, setRoomOrderNeedsRefresh] = useState(false);
  // The room or room type moved last; its row stays tinted until the order is saved.
  const [lastMovedId, setLastMovedId] = useState<string | null>(null);
  const roomViewMenuRef = useRef<HTMLDivElement | null>(null);
  const latestFetchRef = useRef(0);

  // Drag-to-select state for creating bookings/blocks by dragging across day cells. A drag only runs right, up to
  // `limitIdx`, the last free night before the room's next booking or block (VAY-2411).
  const [drag, setDrag] = useState<{
    roomId: string;
    rect: { left: number; width: number; top: number; bottom: number };
    startIdx: number;
    endIdx: number;
    limitIdx: number;
  } | null>(null);
  const [prefill, setPrefill] = useState<{
    roomId: string;
    startDate: string;
    endDate: string;
    anchor: PopoverAnchor;
  } | null>(null);
  const dragActive = drag !== null;

  const endDate = useMemo(() => addDays(startDate, VIEW_DAYS), [startDate]);
  const dates = useMemo(
    () => Array.from({ length: VIEW_DAYS }, (_, i) => addDays(startDate, i)),
    [startDate],
  );
  const dayKeys = useMemo(() => dates.map((d) => format(d, "yyyy-MM-dd")), [dates]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_CALENDAR_QUERY);
    const updateViewport = () => setIsMobileViewport(mediaQuery.matches);
    updateViewport();
    mediaQuery.addEventListener("change", updateViewport);
    return () => mediaQuery.removeEventListener("change", updateViewport);
  }, []);

  // Mobile shows a complete month grid, including the adjacent days that fill
  // its first and last weeks. Desktop keeps its existing timeline/month ranges.
  const fetchRange = useMemo(() => {
    if (isMobileViewport) {
      return {
        start: startOfWeek(startOfMonth(mobileMonth), { weekStartsOn: 1 }),
        end: addDays(endOfWeek(endOfMonth(mobileMonth), { weekStartsOn: 1 }), 1),
      };
    }
    if (viewMode === "month") {
      const mStart = startOfMonth(startDate);
      const mEnd = addDays(endOfMonth(startDate), 1);
      return { start: mStart, end: mEnd };
    }
    return { start: startDate, end: endDate };
  }, [isMobileViewport, mobileMonth, viewMode, startDate, endDate]);

  const fetchData = useCallback(async (): Promise<CalendarData | null> => {
    if (isMobileViewport === null) return null;
    const fetchId = ++latestFetchRef.current;
    setLoading(true);
    setLoadError(false);
    try {
      const nextData = await calendarService.getCalendarData(
        format(fetchRange.start, "yyyy-MM-dd"),
        format(fetchRange.end, "yyyy-MM-dd"),
      );
      if (latestFetchRef.current === fetchId) {
        setData(nextData);
        return nextData;
      }
    } catch (error) {
      console.error(error);
      if (latestFetchRef.current === fetchId) setLoadError(true);
    } finally {
      if (latestFetchRef.current === fetchId) setLoading(false);
    }
    return null;
  }, [fetchRange, isMobileViewport]);

  const handleMobileMonthChange = useCallback((month: Date) => {
    latestFetchRef.current += 1;
    setLoading(true);
    setLoadError(false);
    setMobileMonth(month);
  }, []);

  // Restore view mode from session on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = window.sessionStorage.getItem(VIEW_MODE_STORAGE_KEY);
      if (saved === "month" || saved === "timeline") {
        setViewMode(saved);
        if (saved === "month") {
          setStartDate((d) => startOfMonth(d));
        }
      }
    } catch {
      // sessionStorage may be unavailable (private mode, SSR) — ignore
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  useEffect(() => {
    channexService
      .listChannels()
      .then(({ channels }) => {
        setConnectedChannelKeys(new Set(channels.map((c) => c.key)));
      })
      .catch(() => setConnectedChannelKeys(new Set()));
  }, []);

  const visibleLegendKeys = useMemo(() => {
    const fromBookings = new Set<string>();
    if (data) {
      for (const b of data.bookings) fromBookings.add(normalizeBookingChannel(b.channel));
    }
    return CHANNEL_LEGEND_KEYS.filter(
      (ch) =>
        ALWAYS_SHOWN_LEGEND_KEYS.has(ch.key) ||
        fromBookings.has(ch.key) ||
        (connectedChannelKeys?.has(ch.key) ?? false),
    );
  }, [connectedChannelKeys, data]);

  const handleCellPointerDown = (
    e: React.PointerEvent<HTMLTableCellElement>,
    roomId: string,
    stays: ReadonlyArray<{ start: string; end: string }>,
  ) => {
    if ((e.target as HTMLElement).closest("[data-bar]")) return;
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const idx = Math.max(
      0,
      Math.min(VIEW_DAYS - 1, Math.floor(((e.clientX - rect.left) / rect.width) * VIEW_DAYS)),
    );
    // A booked or blocked night (beside its bar) opens nothing.
    if (nightTaken(stays, dayKeys[idx]!)) return;
    e.preventDefault();
    let limitIdx = idx;
    while (limitIdx < VIEW_DAYS - 1 && !nightTaken(stays, dayKeys[limitIdx + 1]!)) limitIdx++;
    // preventDefault stops the mousedown that would close an open popover, so close them here.
    setPrefill(null);
    setBookingPopover(null);
    setBlockPopover(null);
    setDrag({
      roomId,
      rect: { left: rect.left, width: rect.width, top: rect.top, bottom: rect.bottom },
      startIdx: idx,
      endIdx: idx,
      limitIdx,
    });
  };

  useEffect(() => {
    if (!dragActive) return;
    const handleMove = (ev: PointerEvent) => {
      setDrag((d) => {
        if (!d) return d;
        const idx = Math.max(
          d.startIdx,
          Math.min(d.limitIdx, Math.floor(((ev.clientX - d.rect.left) / d.rect.width) * VIEW_DAYS)),
        );
        return idx === d.endIdx ? d : { ...d, endIdx: idx };
      });
    };
    const handleUp = () => {
      setDrag((d) => {
        if (!d) return null;
        const column = d.rect.width / VIEW_DAYS;
        setPrefill({
          roomId: d.roomId,
          startDate: format(addDays(startDate, d.startIdx), "yyyy-MM-dd"),
          endDate: format(addDays(startDate, d.endIdx + 1), "yyyy-MM-dd"),
          anchor: {
            left: d.rect.left + d.startIdx * column,
            right: d.rect.left + (d.endIdx + 1) * column,
            top: d.rect.top,
            bottom: d.rect.bottom,
          },
        });
        return null;
      });
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [dragActive, startDate]);

  const goToday = () =>
    setStartDate(viewMode === "month" ? startOfMonth(new Date()) : startOfDay(new Date()));
  const goPrev = () =>
    setStartDate((d) => (viewMode === "month" ? subMonths(d, 1) : addDays(d, -7)));
  const goNext = () =>
    setStartDate((d) => (viewMode === "month" ? addMonths(d, 1) : addDays(d, 7)));

  const switchView = (next: ViewMode) => {
    if (next === viewMode) {
      setShowRoomViewMenu(false);
      return;
    }
    // Snap startDate to the 1st of its month when entering month mode, so prev/
    // next month nav lines up. Leaving month mode keeps that same date — per
    // spec, Timeline starts on the first day of the month the user was viewing.
    if (next === "month") {
      setStartDate((d) => startOfMonth(d));
    }
    setViewMode(next);
    setShowRoomViewMenu(false);
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(VIEW_MODE_STORAGE_KEY, next);
      } catch {
        // ignore
      }
    }
  };

  const handleCreateBlock = async (blockData: {
    roomTypeId: string;
    roomIds: string[];
    startDate: string;
    endDate: string;
    reason: string;
  }) => {
    await calendarService.createRoomBlock(blockData);
    setShowBlockModal(false);
    setPrefill(null);
    setMobilePrefill(null);
    await fetchData();
  };

  // Mobile: tapping "Block" opens the shared BlockModal with the selected
  // date range pre-filled (no room pre-selected — the user picks rooms in
  // the modal, matching desktop's room/multi-room selector).
  const handleMobileBlockRoom = (startDate: string, endDate: string) => {
    setPrefill(null);
    setMobilePrefill({ startDate, endDate });
    setShowBlockModal(true);
  };

  // Mobile: tapping "+ New" opens the manual booking modal. If a date range is
  // selected on the mobile calendar, use it as check-in/check-out defaults.
  const handleMobileNewBooking = (startDate?: string, endDate?: string) => {
    setPrefill(null);
    if (startDate && endDate) {
      setMobilePrefill({ startDate, endDate });
    } else {
      setMobilePrefill(null);
    }
    setShowNewBookingModal(true);
  };

  const handleUpdateBlock = async (updates: {
    startDate: string;
    endDate: string;
    reason: string;
  }) => {
    if (!selectedBlock) return;
    await calendarService.updateRoomBlock(selectedBlock.id, selectedBlock.version, updates);
    setSelectedBlock(null);
    await fetchData();
  };

  const handleDeleteBlock = async () => {
    if (!selectedBlock) return;
    await calendarService.deleteRoomBlock(selectedBlock.id, selectedBlock.version);
    setSelectedBlock(null);
    await fetchData();
  };

  const handleCreateBooking = async (bookingData: PmsManualBookingCreateInput) => {
    const result = await calendarService.createManualBooking(bookingData);
    setBookingNotice(
      result.outcome === "replayed"
        ? "Booking already existed; calendar refreshed."
        : "Booking created.",
    );
    setRoomShuffleNotice(
      result.rearrangedBookingCount > 0
        ? {
            eventId: result.commandId,
            bookingCount: result.rearrangedBookingCount,
          }
        : null,
    );
    setShowNewBookingModal(false);
    setPrefill(null);
    setMobilePrefill(null);
    fetchData();
    return result;
  };

  // Reorder helpers (VAY-307).
  const enterReorderMode = () => {
    if (!data || data.rooms.length <= 1) return;
    switchView("timeline");
    setShowRoomViewMenu(false);
    setRoomOrderError(null);
    setRoomOrderNeedsRefresh(false);
    setLocalRooms(groupRoomsByType(data.rooms).flatMap(({ rooms }) => rooms));
    setReorderOrderVersion(data.roomOrderVersion);
    setLastMovedId(null);
    setReorderMode(true);
  };

  // Rooms & Rates' "Reorder room types" opens the calendar with ?reorder=1 (VAY-2338): once the rooms are read,
  // drop the parameter and start reorder mode. Only the wide calendar can reorder.
  const reorderRequestChecked = useRef(false);
  useEffect(() => {
    if (reorderRequestChecked.current || !data || isMobileViewport === null) return;
    reorderRequestChecked.current = true;
    const url = new URL(window.location.href);
    if (url.searchParams.get("reorder") !== "1") return;
    url.searchParams.delete("reorder");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    if (!isMobileViewport) enterReorderMode();
    // enterReorderMode reads the current data; this runs once, when the first data arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, isMobileViewport]);

  const cancelReorder = () => {
    setLocalRooms(null);
    setReorderOrderVersion(null);
    setReorderMode(false);
    setLastMovedId(null);
    setRoomOrderError(null);
    setRoomOrderNeedsRefresh(false);
  };

  // VAY-2294: rooms move within their type; a room type moves with all its rooms.
  const moveRoom = (roomId: string, dir: -1 | 1) => {
    if (savingOrder) return;
    setLocalRooms((rooms) => rooms && moveRoomWithinType(rooms, roomId, dir));
    setLastMovedId(roomId);
  };

  const moveType = (roomTypeId: string, dir: -1 | 1) => {
    if (savingOrder) return;
    setLocalRooms((rooms) => rooms && moveRoomType(rooms, roomTypeId, dir));
    setLastMovedId(roomTypeId);
  };

  const saveReorder = async () => {
    if (!localRooms || !reorderOrderVersion || savingOrder || roomOrderNeedsRefresh) return;
    const intendedRooms = localRooms.slice();
    setRoomOrderError(null);
    setSavingOrder(true);
    try {
      const roomOrderVersion = await calendarService.reorderRooms(
        intendedRooms.map((room) => room.id),
        reorderOrderVersion,
      );
      setData((current) =>
        current ? { ...current, rooms: intendedRooms, roomOrderVersion } : current,
      );
      setReorderMode(false);
      setLocalRooms(null);
      setReorderOrderVersion(null);
      setLastMovedId(null);
      if (!(await fetchData())) {
        setRoomOrderNeedsRefresh(true);
        setRoomOrderError("Room order saved, but the calendar could not refresh.");
      }
    } catch (error) {
      const conflict =
        error instanceof ApiErrorResponse &&
        error.status === 409 &&
        (error.data.code === "room_order_conflict" || error.data.code === "version_conflict");
      if (!conflict) {
        setRoomOrderError("Room order could not be saved. Try again.");
        return;
      }
      setRoomOrderNeedsRefresh(true);
      const refreshed = await fetchData();
      if (refreshed) {
        setLocalRooms(
          mergeRoomOrderIntent(
            intendedRooms,
            refreshed.rooms,
            refreshed.roomTypes.map(({ id }) => id),
          ),
        );
        setReorderOrderVersion(refreshed.roomOrderVersion);
        setRoomOrderNeedsRefresh(false);
        setRoomOrderError("Rooms changed elsewhere. Review the refreshed order, then save again.");
      } else {
        setRoomOrderError("Rooms changed elsewhere, but the current order could not refresh.");
      }
    } finally {
      setSavingOrder(false);
    }
  };

  const retryRoomOrderRefresh = async () => {
    setSavingOrder(true);
    const intendedRooms = localRooms;
    const refreshed = await fetchData();
    if (refreshed) {
      if (intendedRooms) {
        setLocalRooms(
          mergeRoomOrderIntent(
            intendedRooms,
            refreshed.rooms,
            refreshed.roomTypes.map(({ id }) => id),
          ),
        );
        setReorderOrderVersion(refreshed.roomOrderVersion);
      }
      setRoomOrderNeedsRefresh(false);
      setRoomOrderError(null);
    }
    setSavingOrder(false);
  };

  const reorderGroups = reorderMode && localRooms ? groupRoomsByType(localRooms) : [];

  // Whether the user has unsaved changes during reorder mode. Compared with the grouped order
  // reorder mode starts from, so regrouping alone never counts as a change.
  const hasUnsavedOrder = useMemo(() => {
    if (!reorderMode || !localRooms || !data) return false;
    const saved = groupRoomsByType(data.rooms).flatMap(({ rooms }) => rooms);
    if (localRooms.length !== saved.length) return true;
    return localRooms.some((r, i) => r.id !== saved[i].id);
  }, [reorderMode, localRooms, data]);

  // Warn on tab close / refresh when there are unsaved order changes.
  useEffect(() => {
    if (!hasUnsavedOrder) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsavedOrder]);

  // Close the Room View dropdown when clicking outside.
  useEffect(() => {
    if (!showRoomViewMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!roomViewMenuRef.current?.contains(e.target as Node)) {
        setShowRoomViewMenu(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showRoomViewMenu]);

  // Calculate bar position and width relative to the visible date range
  // Bars start at the midpoint of the check-in column and end at the midpoint
  // of the check-out column, matching the standard hotel calendar convention.
  const HALF_COL = 0.5 / VIEW_DAYS; // half a day-column in fraction
  const getBarStyle = (itemStart: string, itemEnd: string) => {
    const s = parseISO(itemStart);
    const e = parseISO(itemEnd);
    const offsetDays = Math.max(0, differenceInDays(s, startDate));
    const endOffset = Math.min(VIEW_DAYS, differenceInDays(e, startDate));
    const spanDays = endOffset - offsetDays;
    if (spanDays <= 0) return null;
    const startsInView = differenceInDays(s, startDate) >= 0;
    const endsInView = differenceInDays(e, startDate) <= VIEW_DAYS;
    const leftShift = startsInView ? HALF_COL : 0;
    const rightShift = endsInView ? HALF_COL : 0;
    return {
      left: `${(offsetDays / VIEW_DAYS + leftShift) * 100}%`,
      width: `${(spanDays / VIEW_DAYS - leftShift + rightShift) * 100}%`,
    };
  };

  // Build a lookup from room type ID to room type (for category, name)
  const roomTypeMap = useMemo(() => {
    if (!data) return {};
    const map: Record<string, { name: string; category: string }> = {};
    for (const rt of data.roomTypes) {
      map[rt.id] = { name: rt.name, category: rt.category };
    }
    return map;
  }, [data]);

  // Group bookings by room ID (for assigned bookings) and room type (for unassigned)
  const bookingsByRoom = useMemo(() => {
    if (!data) return {};
    const map: Record<string, CalendarBooking[]> = {};
    for (const b of data.bookings) {
      if (b.roomId) {
        if (!map[b.roomId]) map[b.roomId] = [];
        map[b.roomId].push(b);
      }
    }
    return map;
  }, [data]);

  const unassignedBookings = useMemo(() => {
    if (!data) return [];
    return data.bookings.filter((b) => !b.roomId);
  }, [data]);

  const getInitials = (first: string, last: string) => {
    return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
  };

  // Group blocks by the room they target. Legacy blocks (roomId === null) fall
  // back to the old "first N rooms of the type" rendering for backwards compat.
  const { blocksByRoom, legacyBlocksByRoomType, roomIndexInType } = useMemo(() => {
    const byRoom: Record<string, CalendarBlock[]> = {};
    const byType: Record<string, CalendarBlock[]> = {};
    const idxMap: Record<string, number> = {};
    if (!data)
      return {
        blocksByRoom: byRoom,
        legacyBlocksByRoomType: byType,
        roomIndexInType: idxMap,
      };
    const counts: Record<string, number> = {};
    for (const room of data.rooms) {
      const idx = counts[room.roomTypeId] || 0;
      idxMap[room.id] = idx;
      counts[room.roomTypeId] = idx + 1;
    }
    for (const bl of data.blocks) {
      if (bl.roomId) {
        if (!byRoom[bl.roomId]) byRoom[bl.roomId] = [];
        byRoom[bl.roomId].push(bl);
      } else {
        if (!byType[bl.roomTypeId]) byType[bl.roomTypeId] = [];
        byType[bl.roomTypeId].push(bl);
      }
    }
    return { blocksByRoom: byRoom, legacyBlocksByRoomType: byType, roomIndexInType: idxMap };
  }, [data]);

  const allBookings = useMemo(() => data?.bookings || [], [data]);

  // Per-room blocks render on their own row; legacy count-based blocks still fill the first N rooms of the type.
  const blocksForRoom = (room: CalendarRoom) => [
    ...(blocksByRoom[room.id] || []),
    ...(legacyBlocksByRoomType[room.roomTypeId] || []).filter(
      (bl) => (roomIndexInType[room.id] ?? 0) < bl.blockedCount,
    ),
  ];

  const publication = prices?.publication ?? null;
  const nightRates = useMemo(
    () => (publication && data ? calendarNightRates(publication, data.roomTypes, dayKeys) : {}),
    [publication, data, dayKeys],
  );
  const rateNames = useMemo(() => {
    const names: Record<string, Record<string, string>> = {};
    for (const roomType of data?.roomTypes ?? []) {
      const room = publication && pricingRoom(publication, roomType.id);
      if (room) names[roomType.id] = calendarRateNames(room, roomType, t);
    }
    return names;
  }, [publication, data, t]);
  const pricesShown = showPrices && publication !== null;
  const todayKey = format(new Date(), "yyyy-MM-dd");

  return (
    <div className="h-full flex flex-col">
      <p className="sr-only" aria-live="polite">
        {bookingNotice}
      </p>
      {roomShuffleNotice && <RoomShuffleNotice {...roomShuffleNotice} />}
      {/* Mobile Calendar */}
      <div className="md:hidden flex-1 flex flex-col">
        {loading && !data ? (
          <div className="p-6 animate-pulse">
            <div className="h-64 bg-gray-200 rounded" />
          </div>
        ) : (
          <MobileCalendar
            hotelTimeZone={hotelTimeZone}
            currentMonth={mobileMonth}
            bookings={allBookings}
            blocks={data?.blocks || []}
            roomTypes={data?.roomTypes || []}
            loading={loading}
            loadError={loadError}
            onMonthChange={handleMobileMonthChange}
            onSelectBooking={openBooking}
            onNewBooking={handleMobileNewBooking}
            onBlockRoom={handleMobileBlockRoom}
            onSelectBlock={(bl) => setSelectedBlock(bl)}
            manualBookingAvailable={MANUAL_BOOKINGS_AVAILABLE}
          />
        )}
      </div>

      {/* Desktop Calendar */}
      <div className="hidden md:flex flex-col flex-1 p-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 mb-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">{t("calendar.title")}</h1>
            <div className="relative inline-block">
              <button
                type="button"
                onClick={() => setShowDatePicker((v) => !v)}
                aria-label={t("calendar.openDatePicker")}
                aria-expanded={showDatePicker}
                className="inline-flex items-center gap-1 text-sm text-primary-600 hover:text-primary-700 underline decoration-dotted underline-offset-4"
              >
                <span>
                  {viewMode === "month" ? (
                    startDate.toLocaleDateString(locale, { month: "long", year: "numeric" })
                  ) : (
                    <>
                      {startDate.toLocaleDateString(locale, { month: "short", day: "numeric" })}{" "}
                      &ndash;{" "}
                      {addDays(endDate, -1).toLocaleDateString(locale, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </>
                  )}
                </span>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>
              {showDatePicker && (
                <MiniDatePicker
                  value={startDate}
                  onChange={(d) => setStartDate(startOfDay(d))}
                  onClose={() => setShowDatePicker(false)}
                />
              )}
            </div>
          </div>
          {reorderMode ? (
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-gray-700">
                {t("calendar.reorderingRooms")}
              </span>
              <button
                onClick={cancelReorder}
                disabled={savingOrder}
                className="px-4 py-1.5 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50"
              >
                {t("calendar.cancel")}
              </button>
              <button
                onClick={saveReorder}
                disabled={savingOrder || roomOrderNeedsRefresh || !hasUnsavedOrder}
                className="px-4 py-1.5 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t("calendar.saveOrder")}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={goToday}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                {t("calendar.today")}
              </button>
              <button
                onClick={goPrev}
                className="px-2.5 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                &larr;
              </button>
              <button
                onClick={goNext}
                className="px-2.5 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                &rarr;
              </button>
              <button
                type="button"
                onClick={() => {
                  setPrefill(null);
                  setShowBlockModal(true);
                }}
                className="px-4 py-1.5 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400"
              >
                {t("calendar.blockRoom")}
              </button>
              <button
                type="button"
                disabled={!MANUAL_BOOKINGS_AVAILABLE}
                title={
                  !MANUAL_BOOKINGS_AVAILABLE ? t("calendar.manualBookingUnavailable") : undefined
                }
                onClick={() => {
                  setPrefill(null);
                  setShowNewBookingModal(true);
                }}
                className="px-4 py-1.5 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                {t("calendar.newBooking")}
              </button>
              {data && (
                <div className="relative" ref={roomViewMenuRef}>
                  <button
                    onClick={() => setShowRoomViewMenu((v) => !v)}
                    aria-label={t("calendar.roomViewMenu")}
                    className="p-2 text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 6h16M4 12h16M4 18h16"
                      />
                    </svg>
                  </button>
                  {showRoomViewMenu && (
                    <div className="absolute right-0 mt-1 w-56 bg-white border border-gray-200 shadow-xl rounded-lg z-50 overflow-hidden">
                      <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 bg-gray-50 border-b border-gray-200">
                        {t("calendar.view")}
                      </div>
                      <button
                        onClick={() => switchView("timeline")}
                        className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
                          viewMode === "timeline"
                            ? "bg-primary-50 text-primary-700 font-medium"
                            : "text-gray-700 hover:bg-gray-50"
                        }`}
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
                            d="M4 6h16M4 12h10M4 18h16"
                          />
                        </svg>
                        {t("calendar.viewTimeline")}
                      </button>
                      <button
                        onClick={() => switchView("month")}
                        className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
                          viewMode === "month"
                            ? "bg-primary-50 text-primary-700 font-medium"
                            : "text-gray-700 hover:bg-gray-50"
                        }`}
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
                            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                          />
                        </svg>
                        {t("calendar.viewMonth")}
                      </button>
                      {data.rooms.length > 1 && (
                        <>
                          <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 bg-gray-50 border-y border-gray-200">
                            {t("calendar.roomView")}
                          </div>
                          <button
                            onClick={enterReorderMode}
                            className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-2"
                          >
                            <svg
                              className="w-4 h-4 text-gray-500"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M8 9l4-4 4 4m0 6l-4 4-4-4"
                              />
                            </svg>
                            {t("calendar.reorderRooms")}
                          </button>
                        </>
                      )}
                      <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 bg-gray-50 border-y border-gray-200">
                        {t("calendar.display")}
                      </div>
                      <div className="px-3 py-2 text-sm text-gray-700 flex items-center justify-between gap-3">
                        <span id="calendar-show-prices">{t("calendar.showPrices")}</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={showPrices}
                          aria-labelledby="calendar-show-prices"
                          onClick={() => setShowPrices(!showPrices)}
                          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 ${showPrices ? "bg-primary-600" : "bg-gray-300"}`}
                        >
                          <span
                            className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${showPrices ? "translate-x-4" : "translate-x-0.5"}`}
                          />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {reorderMode && (
          <div className="mb-4 px-4 py-2.5 bg-primary-50 border border-primary-200 rounded-lg text-xs text-primary-800">
            {reorderGroups.some(({ rooms }) => rooms.length > 1)
              ? t("calendar.reorderHintGroups")
              : t("calendar.reorderHint")}
          </div>
        )}

        {roomOrderError && (
          <div
            role="alert"
            className="mb-4 flex items-center justify-between gap-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800"
          >
            <span>{roomOrderError}</span>
            {roomOrderNeedsRefresh && (
              <button
                type="button"
                disabled={savingOrder}
                onClick={retryRoomOrderRefresh}
                className="shrink-0 font-medium underline disabled:opacity-50"
              >
                {t("calendar.refreshRooms")}
              </button>
            )}
          </div>
        )}

        {/* Channel Legend */}
        <div className="flex items-center gap-4 mb-4">
          {visibleLegendKeys.map((ch) => (
            <div key={ch.key} className="flex items-center gap-1.5">
              {ch.logo ? (
                <img src={ch.logo} alt="" className="w-4 h-4" />
              ) : (
                <div className={`w-3 h-3 rounded-sm ${ch.color}`} />
              )}
              <span className="text-xs text-gray-600">{t(ch.labelKey)}</span>
            </div>
          ))}
        </div>

        {loading && !data ? (
          <div className="animate-pulse">
            <div className="h-64 bg-gray-200 rounded" />
          </div>
        ) : !data || data.rooms.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
            <p className="text-gray-500">{t("calendar.noRooms")}</p>
          </div>
        ) : viewMode === "month" ? (
          <MonthView
            monthStart={startDate}
            rooms={data.rooms}
            roomTypeMap={roomTypeMap}
            bookingsByRoom={bookingsByRoom}
            unassignedBookings={unassignedBookings}
            blocksByRoom={blocksByRoom}
            legacyBlocksByRoomType={legacyBlocksByRoomType}
            roomIndexInType={roomIndexInType}
            onSelectBooking={openBooking}
            onSelectBlock={(bl) => setSelectedBlock(bl)}
          />
        ) : (
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden flex-1 overflow-x-auto">
            <table className="w-full min-w-[600px] md:min-w-[960px] table-fixed">
              {/* Date header */}
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="w-20 md:w-56 px-1.5 md:px-3 py-2 text-left text-[10px] md:text-xs font-medium text-gray-600 sticky left-0 bg-gray-50 z-10 border-r border-gray-200">
                    {t("calendar.roomColumn")}
                  </th>
                  {dates.map((d) => {
                    const isToday = format(d, "yyyy-MM-dd") === format(new Date(), "yyyy-MM-dd");
                    const dow = d.getDay();
                    const isWeekend = dow === 0 || dow === 6;
                    const headerStyle = isToday
                      ? { backgroundColor: "#eff6ff", color: "#2563eb" }
                      : isWeekend
                        ? { backgroundColor: "#fafafa" }
                        : undefined;
                    return (
                      <th
                        key={d.toISOString()}
                        style={headerStyle}
                        className={`px-0.5 py-2 text-center text-[10px] border-r border-gray-100 ${
                          isToday ? "font-bold" : "font-medium text-gray-500"
                        }`}
                      >
                        <div>{d.toLocaleDateString(locale, { weekday: "short" })}</div>
                        <div className={`text-xs ${isToday ? "font-bold" : "font-semibold"}`}>
                          {format(d, "d")}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {(reorderMode && localRooms ? localRooms : data.rooms).map(
                  (room, roomIdx, roomsArr) => {
                    const roomBookings = bookingsByRoom[room.id] || [];
                    const roomBlocks = blocksForRoom(room);
                    const stays = [
                      ...roomBookings.map((b) => ({ start: b.checkIn, end: b.checkOut })),
                      ...roomBlocks.map((bl) => ({ start: bl.startDate, end: bl.endDate })),
                    ];
                    const roomNightRates = pricesShown ? nightRates[room.roomTypeId] : undefined;
                    // The nights being dragged, or those of the open night popover: one field with no day lines
                    // inside (VAY-2411).
                    const selection = (() => {
                      if (drag?.roomId === room.id) return { s: drag.startIdx, e: drag.endIdx };
                      if (prefill?.roomId !== room.id) return null;
                      const ps = differenceInDays(parseISO(prefill.startDate), startDate);
                      const pe = differenceInDays(parseISO(prefill.endDate), startDate) - 1;
                      return pe >= 0 && ps < VIEW_DAYS
                        ? { s: Math.max(0, ps), e: Math.min(VIEW_DAYS - 1, pe) }
                        : null;
                    })();
                    const rt = roomTypeMap[room.roomTypeId];
                    const isFirst = roomsArr[roomIdx - 1]?.roomTypeId !== room.roomTypeId;
                    const isLast = roomsArr[roomIdx + 1]?.roomTypeId !== room.roomTypeId;
                    // Reorder mode (VAY-2294): a type with several rooms gets a header row whose
                    // arrows move the whole type; a one-room type's row arrows move the type.
                    const typeIdx = reorderGroups.findIndex(
                      ({ roomTypeId }) => roomTypeId === room.roomTypeId,
                    );
                    const typeSize = reorderGroups[typeIdx]?.rooms.length ?? 0;
                    const typeName = rt?.name || room.roomTypeName;
                    const typeStepper = (
                      <ReorderStepper
                        upLabel={t("calendar.moveTypeUp", { name: typeName })}
                        downLabel={t("calendar.moveTypeDown", { name: typeName })}
                        upDisabled={savingOrder || typeIdx <= 0}
                        downDisabled={savingOrder || typeIdx >= reorderGroups.length - 1}
                        onUp={() => moveType(room.roomTypeId, -1)}
                        onDown={() => moveType(room.roomTypeId, 1)}
                      />
                    );
                    const typeMoved = reorderMode && lastMovedId === room.roomTypeId;
                    const rowMoved =
                      reorderMode && (lastMovedId === room.id || (typeMoved && typeSize === 1));
                    return (
                      <Fragment key={room.id}>
                        {reorderMode && isFirst && typeSize > 1 && (
                          <tr
                            className={`border-b border-gray-100 ${typeMoved ? "bg-primary-50" : "bg-gray-50"}`}
                          >
                            <td
                              className={`px-3 py-2 sticky left-0 z-10 border-r border-gray-200 ${typeMoved ? "bg-primary-50" : "bg-gray-50"}`}
                            >
                              <div className="flex items-center gap-2.5">
                                {typeStepper}
                                <div className="min-w-0 flex-1">
                                  <div
                                    className="text-[13px] font-semibold text-gray-900 leading-tight truncate"
                                    title={typeName}
                                  >
                                    {typeName}
                                  </div>
                                  <div className="text-[11px] text-gray-500 leading-tight truncate">
                                    {t("calendar.reorderTypeRooms", { count: typeSize })}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td colSpan={VIEW_DAYS} className="h-12 p-0" />
                          </tr>
                        )}
                        <tr
                          className={`border-b border-gray-100 ${reorderMode ? (rowMoved ? "bg-primary-50" : "") : "hover:bg-gray-50/50"}`}
                        >
                          <td
                            className={`px-1.5 md:px-3 py-1.5 md:py-2 sticky left-0 z-10 border-r border-gray-200 ${rowMoved ? "bg-primary-50" : "bg-white"}`}
                          >
                            <div
                              className={`flex items-center ${reorderMode ? "gap-2.5" : "gap-2"}`}
                            >
                              {reorderMode &&
                                (typeSize > 1 ? (
                                  <>
                                    <span
                                      aria-hidden="true"
                                      className="w-6 flex-shrink-0 self-stretch flex justify-center -my-1.5 md:-my-2"
                                    >
                                      <span
                                        className={`w-0.5 bg-gray-200 ${isLast ? "h-1/2" : "h-full"}`}
                                      />
                                    </span>
                                    <ReorderStepper
                                      upLabel={t("calendar.moveUp")}
                                      downLabel={t("calendar.moveDown")}
                                      upDisabled={savingOrder || isFirst}
                                      downDisabled={savingOrder || isLast}
                                      onUp={() => moveRoom(room.id, -1)}
                                      onDown={() => moveRoom(room.id, 1)}
                                    />
                                  </>
                                ) : (
                                  typeStepper
                                ))}
                              <div className="min-w-0 flex-1">
                                <div
                                  className="text-[11px] md:text-sm font-semibold text-gray-900 break-words line-clamp-2 leading-tight"
                                  title={room.roomNumber}
                                >
                                  #{room.roomNumber}
                                </div>
                                <div
                                  className="hidden md:block text-[10px] text-gray-500 leading-tight truncate"
                                  title={
                                    rt?.category
                                      ? `${room.roomTypeName} · ${rt.category}`
                                      : room.roomTypeName
                                  }
                                >
                                  {room.roomTypeName}
                                  {rt?.category && (
                                    <span className="text-gray-400"> &middot; {rt.category}</span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td
                            colSpan={VIEW_DAYS}
                            className={`relative ${pricesShown ? "h-14" : "h-12"} p-0 select-none touch-none ${
                              reorderMode ? "pointer-events-none opacity-60" : "cursor-cell"
                            }`}
                            onPointerDown={(e) => handleCellPointerDown(e, room.id, stays)}
                          >
                            {/* Day grid lines, with the cheapest rate of each free night from today on */}
                            <div className="absolute inset-0 flex">
                              {dates.map((d, i) => {
                                const isToday =
                                  format(d, "yyyy-MM-dd") === format(new Date(), "yyyy-MM-dd");
                                const dow = d.getDay();
                                const isWeekend = dow === 0 || dow === 6;
                                const cellStyle = isToday
                                  ? { backgroundColor: "#f8fbff" }
                                  : isWeekend
                                    ? { backgroundColor: "#fafafa" }
                                    : undefined;
                                const day = dayKeys[i]!;
                                const lowest =
                                  day >= todayKey && !nightTaken(stays, day)
                                    ? roomNightRates?.[day]?.[0]
                                    : undefined;
                                return (
                                  <div
                                    key={d.toISOString()}
                                    style={cellStyle}
                                    className={`flex-1 border-r flex items-end justify-center pb-1 min-w-0 ${
                                      selection && i >= selection.s && i < selection.e
                                        ? "border-transparent"
                                        : "border-gray-100"
                                    }`}
                                  >
                                    {lowest && publication && (
                                      <span className="max-w-full truncate text-[10px] leading-none text-gray-500 tabular-nums">
                                        {cellPrice(lowest.totalMinor, publication.currency, locale)}
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                            {/* Drag-selection overlay — persists while popover is open */}
                            {selection && (
                              <div
                                className="absolute top-1 bottom-1 bg-primary-500/20 border-2 border-primary-500 rounded-md pointer-events-none z-[2]"
                                style={{
                                  left: `${(selection.s / VIEW_DAYS) * 100}%`,
                                  width: `${((selection.e - selection.s + 1) / VIEW_DAYS) * 100}%`,
                                }}
                              />
                            )}
                            {/* Block bars */}
                            {roomBlocks.map((bl) => {
                              const style = getBarStyle(bl.startDate, bl.endDate);
                              if (!style) return null;
                              return (
                                <button
                                  key={`block-${bl.id}`}
                                  type="button"
                                  data-bar="block"
                                  onClick={(e) => openBlock(bl, anchorOf(e.currentTarget))}
                                  className={`absolute top-1.5 h-8 rounded-md px-2 text-[11px] font-medium leading-8 truncate z-[1] border border-dashed flex items-center gap-1 cursor-pointer ${
                                    bl.protected
                                      ? "bg-amber-100 border-amber-300 text-amber-700 hover:bg-amber-200"
                                      : "bg-red-100 border-red-300 text-red-600 hover:bg-red-200"
                                  }`}
                                  style={style}
                                  title={`${bl.protected ? t("rooms.linked") : t("calendar.blocked")}: ${bl.sourceSummary || bl.reason || t("calendar.blockDetail.noReason")}\n${bl.startDate} → ${bl.endDate}${
                                    bl.roomId
                                      ? `\n${t("calendar.roomNumber", { room: bl.roomNumber ?? "" })}`
                                      : `\n${t("calendar.blockDetail.roomCount", { count: bl.blockedCount })}`
                                  }`}
                                >
                                  <svg
                                    className="w-3.5 h-3.5 flex-shrink-0"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                  >
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      strokeWidth={2}
                                      d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                                    />
                                  </svg>
                                  <span className="truncate">
                                    {bl.protected
                                      ? t("rooms.linked")
                                      : bl.reason || t("calendar.blocked")}
                                  </span>
                                </button>
                              );
                            })}
                            {/* Booking bars */}
                            {roomBookings.map((b) => {
                              const style = getBarStyle(b.checkIn, b.checkOut);
                              if (!style) return null;
                              const bar = bookingBar(b);
                              // VAY-403: multi-room reservation spans several rows.
                              const isMultiRoom = b.numberOfRooms > 1;
                              const multiRoomTitle = isMultiRoom
                                ? `\n${t("calendar.bookingRoomPosition", {
                                    reference: b.bookingReference,
                                    position: b.roomPosition + 1,
                                    total: b.numberOfRooms,
                                  })}`
                                : "";
                              return (
                                <div
                                  key={`${b.id}-${b.roomPosition}`}
                                  data-bar="booking"
                                  className={`absolute top-1.5 h-8 rounded-md px-2 text-[11px] font-medium leading-8 truncate cursor-pointer z-[1] ${bar.className} transition-all flex items-center gap-1.5 ${
                                    isMultiRoom ? "ring-1 ring-inset ring-white/50" : ""
                                  }`}
                                  style={{ ...style, ...bar.style }}
                                  title={`${bar.title}${multiRoomTitle}`}
                                  onClick={(e) => openBooking(b, anchorOf(e.currentTarget))}
                                >
                                  <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center text-[9px] font-bold flex-shrink-0">
                                    {getInitials(b.guestFirstName, b.guestLastName)}
                                  </span>
                                  <span className="truncate">{bar.label}</span>
                                  {isMultiRoom && (
                                    <span className="ml-auto pl-1 text-[9px] font-bold opacity-90 flex-shrink-0">
                                      ×{b.numberOfRooms}
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </td>
                        </tr>
                      </Fragment>
                    );
                  },
                )}

                {/* Unassigned bookings row */}
                {unassignedBookings.length > 0 && (
                  <tr className="border-b border-gray-100 bg-amber-50/30">
                    <td className="px-1.5 md:px-3 py-1.5 md:py-2 sticky left-0 bg-amber-50/30 z-10 border-r border-gray-200">
                      <div className="text-[11px] md:text-sm font-medium text-amber-700 truncate">
                        {t("calendar.unassigned")}
                      </div>
                      <div className="hidden md:block text-[10px] text-amber-500">
                        {t("calendar.bookingCount", { count: unassignedBookings.length })}
                      </div>
                    </td>
                    <td
                      colSpan={VIEW_DAYS}
                      className="relative p-0"
                      style={{ height: `${calendarLaneTop(unassignedBookings.length) + 6}px` }}
                    >
                      <div className="absolute inset-0 flex">
                        {dates.map((d) => {
                          const isToday =
                            format(d, "yyyy-MM-dd") === format(new Date(), "yyyy-MM-dd");
                          const dow = d.getDay();
                          const isWeekend = dow === 0 || dow === 6;
                          const cellStyle = isToday
                            ? { backgroundColor: "#f8fbff" }
                            : isWeekend
                              ? { backgroundColor: "#fafafa" }
                              : undefined;
                          return (
                            <div
                              key={d.toISOString()}
                              style={cellStyle}
                              className="flex-1 border-r border-gray-100"
                            />
                          );
                        })}
                      </div>
                      {unassignedBookings.map((b, index) => {
                        const style = getBarStyle(b.checkIn, b.checkOut);
                        if (!style) return null;
                        // prettier-ignore
                        const stayLabel = b.numberOfRooms > 1 ? ` · Room ${b.roomPosition + 1} of ${b.numberOfRooms}` : "";
                        const bar = bookingBar(b, ` - Unassigned${stayLabel}`);
                        return (
                          <div
                            key={`${b.id}-${b.roomPosition}`}
                            data-bar="booking"
                            className={`absolute top-1.5 h-8 rounded-md px-2 text-[11px] font-medium leading-8 truncate cursor-pointer z-[1] ${bar.className} transition-all flex items-center gap-1.5 ${b.status === "awaiting_payment" ? "" : "opacity-75"}`}
                            style={{ ...style, top: `${calendarLaneTop(index)}px`, ...bar.style }}
                            title={bar.title}
                            onClick={(e) => openBooking(b, anchorOf(e.currentTarget))}
                          >
                            <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center text-[9px] font-bold flex-shrink-0">
                              {getInitials(b.guestFirstName, b.guestLastName)}
                            </span>
                            <span className="truncate">{`${bar.label}${stayLabel}`.trim()}</span>
                          </div>
                        );
                      })}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Night popover: the clicked night or the dragged stay (VAY-2411) */}
      {prefill &&
        !showBlockModal &&
        !showNewBookingModal &&
        data &&
        (() => {
          const room = data.rooms.find((r) => r.id === prefill.roomId);
          if (!room) return null;
          return (
            <NightPopover
              room={room}
              startDate={prefill.startDate}
              endDate={prefill.endDate}
              anchor={prefill.anchor}
              currency={publication?.currency ?? null}
              pricesFailed={pricesError !== null}
              nightRates={nightRates[room.roomTypeId]}
              names={rateNames[room.roomTypeId] ?? {}}
              bookings={bookingsByRoom[room.id] || []}
              blocks={blocksForRoom(room)}
              lastDay={dayKeys[VIEW_DAYS - 1]!}
              onNewBooking={
                MANUAL_BOOKINGS_AVAILABLE ? () => setShowNewBookingModal(true) : undefined
              }
              onBlockRoom={() => setShowBlockModal(true)}
              onClose={() => setPrefill(null)}
            />
          );
        })()}

      {bookingPopover && (
        <BookingPopover
          // A new booking starts fresh (its check-in time read).
          key={`${bookingPopover.booking.id}-${bookingPopover.booking.roomPosition}`}
          booking={bookingPopover.booking}
          roomLabel={
            bookingPopover.booking.roomNumber
              ? `#${bookingPopover.booking.roomNumber}`
              : `${t("calendar.unassigned")} · ${bookingPopover.booking.roomName}`
          }
          anchor={bookingPopover.anchor}
          onChangeRoom={() => {
            setSelectedBooking(bookingPopover.booking);
            setBookingPopover(null);
          }}
          onClose={() => setBookingPopover(null)}
        />
      )}

      {blockPopover && (
        <BlockPopover
          // A new block never inherits another block's open "Unblock this period?" confirmation.
          key={blockPopover.block.id}
          block={blockPopover.block}
          anchor={blockPopover.anchor}
          onEdit={() => {
            setSelectedBlock(blockPopover.block);
            setBlockPopover(null);
          }}
          onUnblock={async () => {
            await calendarService.deleteRoomBlock(
              blockPopover.block.id,
              blockPopover.block.version,
            );
            setBlockPopover(null);
            await fetchData();
          }}
          onClose={() => setBlockPopover(null)}
        />
      )}

      {/* Block Modal */}
      {showBlockModal && data && (
        <BlockModal
          roomTypes={data.roomTypes}
          rooms={data.rooms}
          bookings={data.bookings}
          onSubmit={handleCreateBlock}
          onClose={() => {
            setShowBlockModal(false);
            setPrefill(null);
            setMobilePrefill(null);
          }}
          initialStartDate={prefill?.startDate ?? mobilePrefill?.startDate ?? undefined}
          initialEndDate={prefill?.endDate ?? mobilePrefill?.endDate ?? undefined}
          initialRoomTypeId={
            prefill ? data.rooms.find((r) => r.id === prefill.roomId)?.roomTypeId : undefined
          }
          initialRoomId={prefill?.roomId}
        />
      )}

      {/* New Booking Modal */}
      {MANUAL_BOOKINGS_AVAILABLE && showNewBookingModal && data && (
        <TargetManualBookingModal
          roomTypes={data.roomTypes}
          rooms={data.rooms}
          onSubmit={handleCreateBooking}
          onClose={() => {
            setShowNewBookingModal(false);
            setPrefill(null);
            setMobilePrefill(null);
          }}
          initialRoomId={prefill?.roomId}
          initialCheckIn={prefill?.startDate ?? mobilePrefill?.startDate}
          initialCheckOut={prefill?.endDate ?? mobilePrefill?.endDate}
        />
      )}

      {/* Block Detail Modal */}
      {selectedBlock && data && (
        <BlockDetailModal
          block={selectedBlock}
          roomTypes={data.roomTypes}
          onSave={handleUpdateBlock}
          onDelete={handleDeleteBlock}
          onClose={() => setSelectedBlock(null)}
        />
      )}

      {awaitingBooking && (
        <AwaitingPaymentCard
          booking={awaitingBooking}
          timeZone={hotelTimeZone}
          onClose={() => setAwaitingBooking(null)}
        />
      )}

      {/* Booking Detail Modal */}
      {selectedBooking && (
        <BookingDetailModal
          bookingId={selectedBooking.id}
          sourceAssignmentSelector={
            selectedBooking.assignmentId
              ? { assignmentId: selectedBooking.assignmentId }
              : selectedBooking.roomTypeId
                ? { position: selectedBooking.roomPosition }
                : undefined
          }
          onClose={() => setSelectedBooking(null)}
          onStatusChange={fetchData}
          rooms={data?.rooms}
          bookings={data?.bookings}
        />
      )}
    </div>
  );
}
