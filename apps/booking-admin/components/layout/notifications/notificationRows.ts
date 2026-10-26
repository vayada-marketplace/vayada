import { formatCurrency } from "@/lib/utils";
import type {
  HostNotification,
  HostNotificationFeed,
} from "@/services/api/bookingNotificationsClient";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export type NotificationTab = "all" | "bookings" | "needs_action" | "updates";
export const NOTIFICATION_TABS: NotificationTab[] = ["all", "bookings", "needs_action", "updates"];
export type NotificationGroup = "today" | "yesterday" | "thisWeek" | "earlier";

export type NotificationAction =
  | { kind: "view_booking"; reference: string }
  | { kind: "contact_guest"; email: string }
  | { kind: "edit_promo"; promoId: string; label: "extend" | "raiseLimit" };

export type NotificationRow = {
  key: string;
  read: boolean;
  tone: "new" | "modified" | "cancelled" | "payment" | "promo" | "team";
  title: string;
  amount: string | null;
  amountTone: "green" | "red" | "grey" | "default";
  detail: string;
  meta: string;
  action: NotificationAction | null;
};

/** Counts above 9 show "9+". */
export function badgeLabel(count: number): string {
  return count > 9 ? "9+" : String(count);
}

export function unreadForTab(feed: HostNotificationFeed, tab: NotificationTab): number {
  if (tab === "all") return feed.unread.all;
  if (tab === "bookings") return feed.unread.bookings;
  if (tab === "needs_action") return feed.unread.needsAction;
  return feed.unread.updates;
}

export function itemsForTab(items: HostNotification[], tab: NotificationTab): HostNotification[] {
  return tab === "all" ? items : items.filter((item) => item.category === tab);
}

/** The calendar day of an instant in the property's time zone, as yyyy-mm-dd. */
function dayIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function daysBetween(fromDay: string, toDay: string): number {
  return Math.round(
    (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000,
  );
}

/** How many property-calendar days ago an instant was (0 = today). */
export function daysAgo(iso: string, timeZone: string, now: Date): number {
  return daysBetween(dayIn(new Date(iso), timeZone), dayIn(now, timeZone));
}

/** Today, Yesterday, Earlier this week (the last 7 days), then Earlier; in the property's time zone. */
export function groupNotifications(
  items: HostNotification[],
  timeZone: string,
  now: Date,
): { group: NotificationGroup; items: HostNotification[] }[] {
  const groups: { group: NotificationGroup; items: HostNotification[] }[] = [];
  for (const item of items) {
    const days = daysAgo(item.occurredAt, timeZone, now);
    const group: NotificationGroup =
      days <= 0 ? "today" : days === 1 ? "yesterday" : days < 7 ? "thisWeek" : "earlier";
    const last = groups[groups.length - 1];
    if (last?.group === group) last.items.push(item);
    else groups.push({ group, items: [item] });
  }
  return groups;
}

/** "just now", "12 min ago", "5 h ago", "yesterday 18:40", "Mon 10:12", "12 Oct". */
export function relativeTime(
  iso: string,
  timeZone: string,
  now: Date,
  t: Translate,
  locale: string,
): string {
  const at = new Date(iso);
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  const days = daysAgo(iso, timeZone, now);
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  if (minutes < 1) return t("notifications.time.justNow");
  if (minutes < 60) return t("notifications.time.minutesAgo", { count: minutes });
  if (days <= 0) return t("notifications.time.hoursAgo", { count: Math.floor(minutes / 60) });
  if (days === 1) return t("notifications.time.yesterdayAt", { time });
  if (days < 7)
    return `${new Intl.DateTimeFormat(locale, { timeZone, weekday: "short" }).format(at)} ${time}`;
  return new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "short" }).format(at);
}

/** A stay's dates, e.g. "Feb 13 – 18" (the locale decides the order). */
export function stayDates(checkIn: string, checkOut: string, locale: string): string {
  const format = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  });
  return format.formatRange(new Date(`${checkIn}T00:00:00Z`), new Date(`${checkOut}T00:00:00Z`));
}

function nights(checkIn: string, checkOut: string): number {
  return daysBetween(checkIn, checkOut);
}

function money(amount: string | null, currency: string, locale: string): string | null {
  if (amount === null || !Number.isFinite(Number(amount))) return null;
  const value = Number(amount);
  // Whole amounts without cents; others with both digits ("€360.50", not "€360.5").
  const digits = Number.isInteger(value) ? 0 : 2;
  try {
    return formatCurrency(value, currency, locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  } catch {
    return `${currency} ${value.toFixed(digits)}`;
  }
}

function plural(t: Translate, key: string, count: number): string {
  return t(count === 1 ? `${key}.one` : `${key}.other`, { count });
}

const ROLE_KEYS = new Set(["hotel_manager", "front_desk", "housekeeping", "hotel_custom"]);

/** What a notification's row says, in the person's language. */
export function notificationRow(
  item: HostNotification,
  context: { t: Translate; locale: string; timeZone: string; now: Date },
): NotificationRow {
  const { t, locale, timeZone, now } = context;
  const when = relativeTime(item.occurredAt, timeZone, now, t, locale);
  const base = { key: item.key, read: item.read };
  const booking = item.booking;
  if (booking) {
    const who = [booking.guestName || t("notifications.guest"), booking.roomName]
      .filter(Boolean)
      .join(" · ");
    const dates = stayDates(booking.checkIn, booking.checkOut, locale);
    const total = money(booking.totalAmount, booking.currency, locale);
    const view: NotificationAction = { kind: "view_booking", reference: booking.reference };
    if (item.kind === "booking_new") {
      const guests = [plural(t, "notifications.adults", booking.adults)];
      if (booking.children > 0) guests.push(plural(t, "notifications.children", booking.children));
      const rooms =
        booking.roomCount > 1 ? [plural(t, "notifications.rooms", booking.roomCount)] : [];
      const awaiting = booking.awaiting
        ? [
            t(
              booking.awaiting === "payment"
                ? "notifications.awaitingPayment"
                : "notifications.awaitingAnswer",
            ),
          ]
        : [];
      return {
        ...base,
        tone: "new",
        title: t("notifications.kind.bookingNew"),
        amount: total,
        amountTone: "green",
        detail: who,
        meta: [
          dates,
          plural(t, "notifications.nights", nights(booking.checkIn, booking.checkOut)),
          ...rooms,
          ...guests,
          ...awaiting,
          when,
        ].join(" · "),
        action: view,
      };
    }
    if (item.kind === "booking_modified") {
      const change =
        booking.change?.kind === "request"
          ? t("notifications.requestUpdated")
          : t("notifications.datesChanged", { dates });
      const newTotal = money(
        booking.change?.newTotal ?? booking.totalAmount,
        booking.currency,
        locale,
      );
      return {
        ...base,
        tone: "modified",
        title: t("notifications.kind.bookingModified"),
        amount: null,
        amountTone: "default",
        detail: [booking.guestName || t("notifications.guest"), change].join(" · "),
        meta: [
          booking.roomName,
          newTotal ? t("notifications.nowTotal", { amount: newTotal }) : null,
          when,
        ]
          .filter(Boolean)
          .join(" · "),
        action: view,
      };
    }
    if (item.kind === "booking_cancelled") {
      const by =
        booking.cancelReason === "request_expired"
          ? t("notifications.requestExpired")
          : booking.cancelReason === "payment_not_completed"
            ? t("notifications.paymentNotCompleted")
            : t(
                booking.cancelledBy === "guest"
                  ? "notifications.cancelledByGuest"
                  : booking.cancelledBy === "hotel"
                    ? "notifications.cancelledByHotel"
                    : "notifications.cancelledAutomatically",
              );
      return {
        ...base,
        tone: "cancelled",
        title: t("notifications.kind.bookingCancelled"),
        amount: total,
        amountTone: "grey",
        detail: [who, by].join(" · "),
        meta: [
          dates,
          booking.paymentStatus === "unpaid" ? t("notifications.noPaymentTaken") : null,
          when,
        ]
          .filter(Boolean)
          .join(" · "),
        action: null,
      };
    }
    // Payment not received: a bank transfer that missed its deadline.
    return {
      ...base,
      tone: "payment",
      title: t("notifications.kind.paymentNotReceived"),
      amount: total,
      amountTone: "red",
      detail: [who, t("notifications.transferMissed")].join(" · "),
      meta: [dates, t("notifications.bookingCancelled"), when].join(" · "),
      action: booking.guestEmail ? { kind: "contact_guest", email: booking.guestEmail } : view,
    };
  }
  if (item.promo) {
    const { promo } = item;
    if (item.kind === "promo_ending") {
      const ends = promo.validUntil
        ? new Intl.DateTimeFormat(locale, {
            timeZone: "UTC",
            day: "numeric",
            month: "short",
          }).format(new Date(`${promo.validUntil}T00:00:00Z`))
        : "";
      return {
        ...base,
        tone: "promo",
        title: t("notifications.kind.promoEnding"),
        amount: null,
        amountTone: "default",
        detail: [
          promo.code,
          plural(t, "notifications.usedTimes", promo.uses),
          t("notifications.endsOn", { date: ends }),
        ].join(" · "),
        meta: when,
        action: { kind: "edit_promo", promoId: promo.id, label: "extend" },
      };
    }
    return {
      ...base,
      tone: "promo",
      title: t("notifications.kind.promoLimit"),
      amount: null,
      amountTone: "default",
      detail: [
        promo.code,
        t("notifications.usesOfLimit", { uses: promo.uses, limit: promo.maxUses }),
      ].join(" · "),
      meta: when,
      action: { kind: "edit_promo", promoId: promo.id, label: "raiseLimit" },
    };
  }
  const member = item.member ?? { name: null, role: "" };
  const role = ROLE_KEYS.has(member.role) ? t(`notifications.role.${member.role}`) : member.role;
  return {
    ...base,
    tone: "team",
    title: t("notifications.kind.teamJoined"),
    amount: null,
    amountTone: "default",
    detail: t("notifications.joinedAs", {
      name: member.name ?? t("notifications.memberFallback"),
      role,
    }),
    meta: when,
    action: null,
  };
}

/** The pinned card's text: what stopped updating and since when. */
export function syncAlertText(
  alert: NonNullable<HostNotificationFeed["syncAlert"]>,
  context: { t: Translate; locale: string; timeZone: string; now: Date },
): string {
  const { t, locale, timeZone, now } = context;
  const availability = alert.domains.includes("ari");
  if (!alert.lastSuccessAt)
    return t(
      availability ? "notifications.sync.availabilityNever" : "notifications.sync.bookingsNever",
    );
  const since = new Date(alert.lastSuccessAt);
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(since);
  const when =
    daysAgo(alert.lastSuccessAt, timeZone, now) <= 0
      ? time
      : new Intl.DateTimeFormat(locale, {
          timeZone,
          day: "numeric",
          month: "short",
          hour: "numeric",
          minute: "2-digit",
        }).format(since);
  return t(
    availability ? "notifications.sync.availabilitySince" : "notifications.sync.bookingsSince",
    {
      time: when,
    },
  );
}
