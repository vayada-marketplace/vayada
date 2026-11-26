import type {
  ChannelManagerMarkup,
  ChannelManagerProblem,
  ChannelManagerView,
} from "@/services/channelManager";
import { bookingChannelLabel } from "@/lib/bookings/channelLabel";

export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** A problem as the page shows it: alerts from Channex, plus prices that don't go out. */
export type ProblemCard = Readonly<{
  key: string;
  /** The alert to mark as seen; null for the price sync, which clears by itself. */
  alertId: string | null;
  title: string;
  body: string;
  meta: string;
  /** Retried by us: nothing for the hotel to do. */
  retrying: boolean;
  openCalendar: boolean;
  seen: boolean;
}>;

/** "BookingCom", "AirBNB", "booking_com" → "Booking.com", "Airbnb"; null when unknown. */
export function otaName(code: string | null | undefined, t: Translate): string | null {
  if (!code) return null;
  const alias = code.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  if (alias === "bookingcom") return t("channelManager.channels.bookingCom");
  if (alias === "airbnb") return t("channelManager.channels.airbnb");
  return bookingChannelLabel(code, t);
}

/** "+12%", "+12% then +3.50 EUR", "None"; "Varies by room" or "—" when it can't be one value. */
export function markupText(markup: ChannelManagerMarkup, locale: string, t: Translate): string {
  if (markup.kind === "varies") return t("channelManager.channels.markupVaries");
  if (markup.kind === "unknown") return "—";
  if (!markup.rules.length) return t("channelManager.channels.markupNone");
  return markup.rules
    .map(({ operation, value }) => {
      const sign = operation.startsWith("increase") ? "+" : "−";
      const amount = Number(value);
      if (operation.endsWith("percent"))
        return `${sign}${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(amount)}%`;
      return `${sign}${
        markup.currency
          ? new Intl.NumberFormat(locale, { style: "currency", currency: markup.currency }).format(
              amount,
            )
          : value
      }`;
    })
    .join(` ${t("channelManager.channels.markupThen")} `);
}

/** "today, 14:02", "yesterday, 09:14", "12 Dec, 14:02", in the reader's time zone. */
export function whenText(iso: string, locale: string, t: Translate, now = new Date()): string {
  const at = new Date(iso);
  const time = clock(locale).format(at);
  const day = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return t("channelManager.when.today", { time });
  if (days === 1) return t("channelManager.when.yesterday", { time });
  const date = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(at);
  return t("channelManager.when.other", { date, time });
}

/** "14:02": the 24-hour clock, as the rest of the hotel's day. */
function clock(locale: string) {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** A stay's dates, "12–14 Dec" (with the year when it isn't this year's). */
export function stayText(from: string, to: string | null, locale: string, now = new Date()) {
  const start = new Date(`${from}T00:00:00Z`);
  const end = to ? new Date(`${to}T00:00:00Z`) : null;
  const format = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    ...(start.getUTCFullYear() === now.getFullYear() &&
    (!end || end.getUTCFullYear() === now.getFullYear())
      ? {}
      : { year: "numeric" }),
  });
  return end && end > start ? format.formatRange(start, end) : format.format(start);
}

export function listText(items: readonly string[], locale: string) {
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
}

/** The page's problems in plain words, with what to do: open alerts first, then prices that don't go out and
 * bookings that aren't checked. These two clear by themselves once the sync works again. */
export function problemCards(
  view: ChannelManagerView,
  locale: string,
  t: Translate,
  now = new Date(),
): ProblemCard[] {
  const cards = view.problems.map((problem) => alertCard(problem, locale, t, now));
  const prices = view.sync.prices;
  if (prices.status === "retrying" || prices.status === "failed") {
    const retrying = prices.status === "retrying" && prices.retryAt !== null;
    cards.push({
      key: "prices",
      alertId: null,
      retrying,
      openCalendar: false,
      seen: false,
      title: t(
        retrying
          ? "channelManager.problems.pricesRetryingTitle"
          : "channelManager.problems.pricesFailedTitle",
      ),
      body: retrying
        ? t("channelManager.problems.pricesRetryingBody", {
            time: clock(locale).format(new Date(prices.retryAt!)),
          })
        : t("channelManager.problems.pricesFailedBody"),
      meta: prices.lastSuccessAt
        ? t("channelManager.sync.lastSent", {
            when: whenText(prices.lastSuccessAt, locale, t, now),
          })
        : t("channelManager.sync.notSentYet"),
    });
  }
  if (prices.status === "partial")
    cards.push({
      key: "prices",
      alertId: null,
      retrying: false,
      openCalendar: false,
      seen: false,
      title: t("channelManager.problems.pricesPartialTitle"),
      body: t("channelManager.problems.pricesPartialBody"),
      meta: prices.lastSuccessAt
        ? t("channelManager.sync.lastSent", {
            when: whenText(prices.lastSuccessAt, locale, t, now),
          })
        : "",
    });
  const bookings = view.sync.bookings;
  if (bookings.status === "failed")
    cards.push({
      key: "bookings",
      alertId: null,
      retrying: false,
      openCalendar: false,
      seen: false,
      title: t("channelManager.problems.bookingsFailedTitle"),
      body: bookings.lastCheckedAt
        ? t("channelManager.problems.bookingsFailedBody", {
            when: whenText(bookings.lastCheckedAt, locale, t, now),
          })
        : t("channelManager.problems.bookingsFailedBodyNever"),
      meta: bookings.lastCheckedAt
        ? t("channelManager.sync.lastChecked", {
            when: whenText(bookings.lastCheckedAt, locale, t, now),
          })
        : t("channelManager.sync.notCheckedYet"),
    });
  return cards;
}

function alertCard(
  problem: ChannelManagerProblem,
  locale: string,
  t: Translate,
  now: Date,
): ProblemCard {
  const named = otaName(problem.channel, t);
  const channel = named ?? t("channelManager.problems.theChannel");
  const dates = problem.dateFrom ? stayText(problem.dateFrom, problem.dateTo, locale, now) : null;
  const room = problem.roomTypeName;
  const reference = problem.reference
    ? t("channelManager.problems.withReference", { reference: problem.reference })
    : "";
  const title = (key: string) =>
    named ? t(`${key}Title`, { channel: named }) : t(`${key}TitleNoChannel`);
  const card = (
    key: string,
    body: string,
    extra: Partial<Pick<ProblemCard, "retrying" | "openCalendar">> = {},
  ): ProblemCard => ({
    key: problem.id,
    alertId: problem.id,
    title: title(`channelManager.problems.${key}`),
    body,
    meta: [
      named,
      room,
      dates,
      t("channelManager.problems.firstSeen", {
        when: whenText(problem.firstOccurredAt, locale, t, now),
      }),
    ]
      .filter(Boolean)
      .join(" · "),
    retrying: extra.retrying ?? false,
    openCalendar: extra.openCalendar ?? false,
    seen: problem.acknowledgedAt !== null,
  });

  switch (problem.eventType) {
    case "booking_not_imported": {
      const findIt = t("channelManager.problems.findInExtranet", { channel, reference });
      if (problem.errorType === "operational_inventory_unavailable")
        return card(
          "notAdded",
          room && dates
            ? t("channelManager.problems.soldTwice", { room, dates, channel })
            : t("channelManager.problems.soldTwiceNoRoom", { channel }),
          { openCalendar: true },
        );
      if (problem.errorType === "inventory_not_open")
        return card("notAdded", `${t("channelManager.problems.nightsClosed")} ${findIt}`, {
          openCalendar: true,
        });
      if (problem.errorType === "operational_assignment_conflict")
        return card("notAdded", t("channelManager.problems.roomInTheWay"));
      if (problem.errorType === "operational_booking_terminal")
        return card("notAdded", t("channelManager.problems.stayFinished"));
      if (problem.errorType === "operational_mapping_unavailable")
        return card("notAdded", `${t("channelManager.problems.roomNotLinked")} ${findIt}`);
      return card("notAdded", `${t("channelManager.problems.notInPms", { channel })} ${findIt}`);
    }
    case "booking_on_closed_night":
      return card(
        "closedNights",
        t(
          problem.errorType === "inventory_linked_stop_sell"
            ? "channelManager.problems.closedNightsLinked"
            : "channelManager.problems.closedNightsBody",
          { channel },
        ),
        { openCalendar: true },
      );
    case "booking_unmapped_room":
    case "booking_unmapped_rate":
      return card(
        "unmatched",
        `${t("channelManager.problems.roomNotLinked")} ${t("channelManager.problems.findInExtranet", { channel, reference })}`,
      );
    case "non_acked_booking":
      return card(
        "confirming",
        `${t("channelManager.problems.confirmingBody")} ${t("channelManager.problems.findInExtranetIfMissing", { channel, reference })}`,
      );
    case "rate_error":
    case "sync_error":
    case "sync_warning":
      return card("updateRefused", t("channelManager.problems.updateRefusedBody", { channel }));
    case "disconnected_channel":
      return card("disconnected", t("channelManager.problems.disconnectedBody", { channel }));
    default:
      return card("other", t("channelManager.problems.otherBody"));
  }
}

/** Connected, Needs attention (a problem not yet seen, or a sync not working) or Not connected. */
export function overallStatus(
  view: ChannelManagerView,
  problems: readonly ProblemCard[],
): "connected" | "attention" | "notConnected" {
  if (view.connection.status !== "connected" && view.connection.status !== "degraded")
    return "notConnected";
  return problems.some((problem) => !problem.seen) ? "attention" : "connected";
}
