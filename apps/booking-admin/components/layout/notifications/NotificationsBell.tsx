"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowPathIcon,
  BanknotesIcon,
  BellIcon,
  CalendarIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  TicketIcon,
  UserPlusIcon,
  XCircleIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { createBrowserAuthHandoff, crossAppReauthenticationUrl } from "@vayada/product-onboarding";
import { useTranslation } from "@/lib/i18n";
import { openNotificationLink } from "@/lib/notificationLinks";
import { getAuthCsrfToken } from "@/services/auth/sessionStore";
import {
  bookingNotificationsClient,
  type HostNotificationFeed,
} from "@/services/api/bookingNotificationsClient";
import {
  NOTIFICATION_TABS,
  badgeLabel,
  groupNotifications,
  itemsForTab,
  notificationRow,
  syncAlertText,
  unreadForTab,
  type NotificationAction,
  type NotificationRow,
  type NotificationTab,
} from "./notificationRows";
import type { useHostNotifications } from "./useHostNotifications";

const PMS_FRONTEND_URL = process.env.NEXT_PUBLIC_PMS_FRONTEND_URL || "https://pms.vayada.com";

const TAB_LABEL: Record<NotificationTab, string> = {
  all: "notifications.tab.all",
  bookings: "notifications.tab.bookings",
  needs_action: "notifications.tab.needsAction",
  updates: "notifications.tab.updates",
};
const EMPTY_TAB_BODY: Record<NotificationTab, string> = {
  all: "notifications.empty.all",
  bookings: "notifications.empty.bookings",
  needs_action: "notifications.empty.needsAction",
  updates: "notifications.empty.updates",
};
const TONE: Record<NotificationRow["tone"], { icon: typeof BellIcon; tile: string }> = {
  new: { icon: CalendarIcon, tile: "bg-green-50 text-green-600" },
  modified: { icon: ArrowPathIcon, tile: "bg-blue-50 text-blue-600" },
  cancelled: { icon: XCircleIcon, tile: "bg-gray-100 text-gray-500" },
  payment: { icon: BanknotesIcon, tile: "bg-red-50 text-red-600" },
  promo: { icon: TicketIcon, tile: "bg-amber-50 text-amber-600" },
  team: { icon: UserPlusIcon, tile: "bg-primary-50 text-primary-600" },
};
const AMOUNT_TONE: Record<NotificationRow["amountTone"], string> = {
  green: "text-green-700",
  red: "text-red-700",
  grey: "text-gray-500",
  default: "text-gray-700",
};
const SECONDARY_BUTTON =
  "inline-flex h-[30px] items-center rounded-[7px] border border-gray-300 bg-white px-3 text-[13px] font-medium text-gray-700 hover:bg-gray-50";

type Notifications = ReturnType<typeof useHostNotifications>;

/** Booking Admin's bell and notifications panel (VAY-2349): a dropdown from 768 px, a full-width sheet
 * under the header on phones. */
export default function NotificationsBell({
  hotelId,
  hotelName,
  notifications,
}: {
  hotelId: string | undefined;
  hotelName: string;
  notifications: Notifications;
}) {
  const { t, locale } = useTranslation();
  const router = useRouter();
  const { feed, failed, reload, markRead, markAllRead } = notifications;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<NotificationTab>("all");
  const [sync, setSync] = useState<"idle" | "starting" | "started" | "failed">("idle");
  const [synced, setSynced] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const hadAlert = useRef(false);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // A sync error that clears while the panel is open turns into a green "synced" line until it closes.
  useEffect(() => {
    if (!feed) return;
    if (feed.syncAlert) hadAlert.current = true;
    else if (hadAlert.current) {
      hadAlert.current = false;
      if (open) setSynced(true);
      setSync("idle");
    }
  }, [feed, open]);

  useEffect(() => {
    if (!open) setSynced(false);
  }, [open]);

  const unread = feed?.unread.all ?? 0;
  const badge = feed && unread > 0 ? feed.badge : "none";
  const now = new Date();
  const context = { t, locale, timeZone: feed?.timeZone ?? "UTC", now };

  const act = (row: NotificationRow, action: NotificationAction) => {
    if (!row.read) void markRead([row.key]);
    if (action.kind === "contact_guest") {
      window.location.href = `mailto:${action.email}`;
      return;
    }
    setOpen(false);
    if (action.kind === "view_booking")
      openNotificationLink(
        { path: "/reservations", param: "search" },
        action.reference,
        router.push,
      );
    else openNotificationLink({ path: "/promo-codes", param: "edit" }, action.promoId, router.push);
  };

  const retrySync = async (alert: NonNullable<HostNotificationFeed["syncAlert"]>) => {
    if (!hotelId) return;
    if (!alert.read) void markRead([alert.key]);
    setSync("starting");
    try {
      await bookingNotificationsClient.retrySync(hotelId, alert.domains);
      setSync("started");
      // The sync runs in the background; look again shortly, then on the usual minute.
      window.setTimeout(() => void reload(), 15_000);
    } catch {
      setSync("failed");
    }
  };

  const openChannelManager = async (alert: NonNullable<HostNotificationFeed["syncAlert"]>) => {
    if (!alert.read) void markRead([alert.key]);
    const targetPath = "/channel-manager";
    const csrfToken = getAuthCsrfToken();
    if (csrfToken && hotelId) {
      try {
        window.location.href = await createBrowserAuthHandoff({
          csrfToken,
          routingHints: { propertyId: hotelId },
          sourceSurface: "booking-admin",
          targetPath,
          targetSurface: "pms-web",
        });
        return;
      } catch {
        // Require PMS sign-in when the one-time exchange is unavailable.
      }
    }
    window.location.href = crossAppReauthenticationUrl(PMS_FRONTEND_URL, targetPath);
  };

  const items = feed ? itemsForTab(feed.items, tab) : [];
  const alert = feed?.syncAlert ?? null;
  const showAlert = alert !== null && (tab === "all" || tab === "needs_action");
  const nothingAtAll = feed !== null && feed.items.length === 0 && alert === null && !synced;

  return (
    <div className="relative" ref={box}>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={
          unread > 0
            ? t("notifications.bellUnread", { count: unread })
            : t("layout.header.notifications")
        }
        className={`relative flex rounded-md p-1.5 transition-colors ${
          open ? "bg-gray-100 text-gray-700" : "text-gray-500 hover:bg-gray-50 hover:text-gray-700"
        }`}
      >
        <BellIcon className="h-4 w-4" />
        {badge !== "none" && (
          <span
            data-testid="notifications-badge"
            data-tone={badge}
            className={`absolute -right-1 -top-[3px] flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold leading-3 text-white ring-2 ring-white ${
              badge === "red" ? "bg-red-600" : "bg-primary-600"
            }`}
          >
            {badgeLabel(unread)}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t("layout.header.notifications")}
          className="fixed inset-x-0 bottom-0 top-12 z-50 flex flex-col overflow-hidden border-t border-gray-200 bg-white md:absolute md:inset-x-auto md:bottom-auto md:right-0 md:top-full md:mt-1.5 md:max-h-[min(640px,calc(100vh-64px))] md:w-[400px] md:rounded-xl md:border md:shadow-[0_12px_32px_rgba(17,24,39,0.14),0_2px_6px_rgba(17,24,39,0.06)]"
        >
          <div className="flex shrink-0 items-center justify-between px-4 pb-3 pt-4">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-semibold leading-[22px] text-gray-900">
                {t("layout.header.notifications")}
              </h2>
              {unread > 0 && (
                <span className="flex h-5 items-center rounded-full bg-primary-50 px-2 text-xs font-semibold text-primary-600">
                  {t("notifications.newCount", { count: unread })}
                </span>
              )}
            </div>
            <div className="flex items-center gap-4">
              {unread > 0 && (
                <button
                  type="button"
                  onClick={() => feed && void markAllRead(feed)}
                  className="text-[13px] font-medium text-primary-600 hover:text-primary-700"
                >
                  {t("notifications.markAllRead")}
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t("notifications.close")}
                className="text-gray-500 hover:text-gray-700 md:hidden"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>
          </div>

          <div
            role="tablist"
            aria-label={t("layout.header.notifications")}
            className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-gray-200 px-2.5 pb-3 md:gap-1 md:px-3"
          >
            {NOTIFICATION_TABS.map((name) => {
              const count = feed ? unreadForTab(feed, name) : 0;
              const active = name === tab;
              return (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(name)}
                  className={`flex h-[30px] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] ${
                    active
                      ? "bg-gray-900 font-semibold text-white"
                      : "font-medium text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {t(TAB_LABEL[name])}
                  {count > 0 && (
                    <span
                      className={`flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-[5px] text-[11px] font-bold ${
                        active
                          ? "bg-white text-gray-900"
                          : name === "needs_action"
                            ? "bg-red-50 text-red-600"
                            : "bg-primary-50 text-primary-600"
                      }`}
                    >
                      {badgeLabel(count)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {!feed && (
              <p className="px-4 py-10 text-center text-[13px] text-gray-500">
                {failed ? t("notifications.loadFailed") : t("notifications.loading")}
              </p>
            )}

            {synced && (tab === "all" || tab === "needs_action") && (
              <div
                role="status"
                className="mx-4 mb-1 mt-3 flex items-center gap-2.5 rounded-[10px] border border-green-200 bg-green-50 px-3 py-2.5 text-[13px]"
              >
                <CheckCircleIcon className="h-[18px] w-[18px] shrink-0 text-green-600" />
                <span className="font-semibold text-green-800">
                  {t("notifications.sync.synced")}
                </span>
                <span className="text-green-700">· {t("notifications.time.justNow")}</span>
              </div>
            )}

            {showAlert && alert && (
              <div className="mx-4 mb-1 mt-3 flex gap-3 rounded-[10px] border border-red-200 bg-red-50 p-3.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-100">
                  <ExclamationTriangleIcon className="h-[18px] w-[18px] text-red-600" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-red-800">
                      {t("notifications.sync.title")}
                    </h3>
                    <span className="flex h-[18px] items-center rounded border border-red-200 bg-white px-1.5 text-[10px] font-bold tracking-[0.06em] text-red-700">
                      {t("notifications.sync.urgent")}
                    </span>
                  </div>
                  <p className="text-[13px] leading-[19px] text-red-800">
                    {syncAlertText(alert, context)}
                  </p>
                  {sync === "failed" && (
                    <p role="alert" className="text-xs text-red-700">
                      {t("notifications.sync.retryFailed")}
                    </p>
                  )}
                  {alert.canRetry && (
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={sync === "starting" || sync === "started"}
                        onClick={() => void retrySync(alert)}
                        className="inline-flex h-[30px] items-center rounded-[7px] bg-red-700 px-3 text-[13px] font-medium text-white hover:bg-red-800 disabled:opacity-70"
                      >
                        {sync === "starting" || sync === "started"
                          ? t("notifications.sync.syncing")
                          : t("notifications.sync.retry")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void openChannelManager(alert)}
                        className="inline-flex h-[30px] items-center rounded-[7px] border border-red-200 bg-white px-3 text-[13px] font-medium text-red-800 hover:bg-red-50"
                      >
                        {t("notifications.sync.viewDetails")}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {feed && nothingAtAll && (
              <Empty
                title={t("notifications.caughtUp.title")}
                body={t("notifications.caughtUp.body", { hotel: hotelName })}
                caughtUp
              />
            )}
            {feed && !nothingAtAll && items.length === 0 && !(showAlert || synced) && (
              <Empty
                title={t("notifications.empty.title")}
                body={t(EMPTY_TAB_BODY[tab], { hotel: hotelName })}
              />
            )}

            {feed &&
              groupNotifications(items, feed.timeZone, now).map(({ group, items: grouped }) => (
                <section key={group} aria-label={t(`notifications.group.${group}`)}>
                  <h3 className="px-4 pb-1.5 pt-3.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-500">
                    {t(`notifications.group.${group}`)}
                  </h3>
                  <ul>
                    {grouped.map((item, index) => (
                      <Row
                        key={item.key}
                        row={notificationRow(item, context)}
                        last={index === grouped.length - 1}
                        onMarkRead={(key) => void markRead([key])}
                        onAction={act}
                      />
                    ))}
                  </ul>
                </section>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  row,
  last,
  onMarkRead,
  onAction,
}: {
  row: NotificationRow;
  last: boolean;
  onMarkRead: (key: string) => void;
  onAction: (row: NotificationRow, action: NotificationAction) => void;
}) {
  const { t } = useTranslation();
  const { icon: Icon, tile } = TONE[row.tone];
  const action = row.action;
  const label =
    action?.kind === "contact_guest"
      ? t("notifications.action.contactGuest")
      : action?.kind === "edit_promo"
        ? t(
            action.label === "extend"
              ? "notifications.action.extend"
              : "notifications.action.raiseLimit",
          )
        : t("notifications.action.viewBooking");
  return (
    <li
      data-testid="notification-row"
      data-unread={row.read ? undefined : "true"}
      className={`flex gap-3 py-3 pl-4 pr-3 ${row.read ? "" : "bg-[#F5F7FF]"} ${
        last ? "" : "border-b border-gray-100"
      }`}
    >
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tile}`}>
        <Icon className="h-[17px] w-[17px]" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-start justify-between gap-2">
          <p className={`text-sm text-gray-900 ${row.read ? "font-medium" : "font-semibold"}`}>
            {row.title}
          </p>
          {row.amount && (
            <span className={`shrink-0 text-[13px] font-semibold ${AMOUNT_TONE[row.amountTone]}`}>
              {row.amount}
            </span>
          )}
        </div>
        <p className="text-[13px] leading-[18px] text-gray-700">{row.detail}</p>
        <p className="text-xs text-gray-500">{row.meta}</p>
        {action && (
          <div className="mt-2 flex">
            <button
              type="button"
              onClick={() => onAction(row, action)}
              className={
                action.kind === "contact_guest"
                  ? "inline-flex h-[30px] items-center rounded-[7px] bg-gray-900 px-3 text-[13px] font-medium text-white hover:bg-gray-800"
                  : SECONDARY_BUTTON
              }
            >
              {label}
            </button>
          </div>
        )}
      </div>
      <div className="flex w-3 shrink-0 justify-center pt-1.5">
        {!row.read && (
          <button
            type="button"
            onClick={() => onMarkRead(row.key)}
            aria-label={t("notifications.markRead")}
            className="h-2 w-2 rounded-full bg-primary-500 ring-primary-200 hover:ring-4"
          />
        )}
      </div>
    </li>
  );
}

function Empty({
  title,
  body,
  caughtUp = false,
}: {
  title: string;
  body: string;
  caughtUp?: boolean;
}) {
  const Icon = caughtUp ? CheckCircleIcon : BellIcon;
  return (
    <div className="flex flex-col items-center gap-2 px-8 pb-11 pt-10 text-center">
      <span
        className={`mb-1 flex h-11 w-11 items-center justify-center rounded-full ${
          caughtUp ? "bg-green-50 text-green-600" : "bg-gray-100 text-gray-400"
        }`}
      >
        <Icon className="h-[22px] w-[22px]" />
      </span>
      <p className="text-[15px] font-semibold text-gray-900">{title}</p>
      <p className="max-w-[280px] text-[13px] leading-[19px] text-gray-500">{body}</p>
    </div>
  );
}
