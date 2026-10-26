"use client";

import { useEffect, useRef, useState } from "react";
import {
  BanknotesIcon,
  CalendarIcon,
  ExclamationTriangleIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { useTranslation } from "@/lib/i18n";
import type { HostNotificationFeed } from "@/services/api/bookingNotificationsClient";
import { notificationRow } from "./notificationRows";
import { TOAST_MS, nextToasts, type Toast } from "./notificationToasts";
import type { useNotificationActions } from "./useNotificationActions";

type Actions = ReturnType<typeof useNotificationActions>;

/** Toasts for a new booking, a missed payment and a sync error that arrive while Booking Admin is open
 * (VAY-2349): bottom right, at most 3; on phones the newest only, full width. */
export default function NotificationToasts({
  hotelId,
  feed,
  actions,
}: {
  hotelId: string | undefined;
  feed: HostNotificationFeed | null;
  actions: Actions;
}) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const shown = useRef<Toast[]>([]);
  const seen = useRef<{ hotelId: string; keys: Set<string> } | null>(null);

  useEffect(() => {
    if (!feed || !hotelId) return;
    const previous = seen.current?.hotelId === hotelId ? seen.current.keys : null;
    const next = nextToasts(previous ? shown.current : [], previous, feed);
    seen.current = { hotelId, keys: next.seen };
    shown.current = next.toasts;
    setToasts(next.toasts);
  }, [feed, hotelId]);

  const close = (key: string) => {
    shown.current = shown.current.filter((toast) => toast.key !== key);
    setToasts(shown.current);
  };

  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="fixed inset-x-4 bottom-4 z-[60] flex flex-col gap-2.5 md:left-auto md:right-6 md:bottom-6 md:w-[360px]"
    >
      {toasts.map((toast) => (
        <ToastCard
          key={toast.key}
          toast={toast}
          feed={feed}
          actions={actions}
          onClose={() => close(toast.key)}
        />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  feed,
  actions,
  onClose,
}: {
  toast: Toast;
  feed: HostNotificationFeed | null;
  actions: Actions;
  onClose: () => void;
}) {
  const { t, locale } = useTranslation();
  const sticky = toast.type === "sync";
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    if (sticky) return;
    const timer = window.setTimeout(() => closeRef.current(), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [sticky]);

  let title: string;
  let detail: string;
  let tile: string;
  let Icon: typeof CalendarIcon;
  let button: { label: string; run: () => void } | null = null;
  if (toast.type === "sync") {
    title = t("notifications.sync.title");
    detail = t("notifications.toast.syncDetail");
    tile = "bg-red-100 text-red-600";
    Icon = ExclamationTriangleIcon;
    if (toast.alert.canRetry)
      button = {
        label: t("notifications.sync.retry"),
        run: () => void actions.retrySync(toast.alert),
      };
  } else {
    const row = notificationRow(toast.item, {
      t,
      locale,
      timeZone: feed?.timeZone ?? "UTC",
      now: new Date(),
    });
    title = row.amount ? `${row.title} · ${row.amount}` : row.title;
    detail = row.detail;
    const payment = toast.item.kind === "payment_not_received";
    tile = payment ? "bg-red-50 text-red-600" : "bg-green-50 text-green-600";
    Icon = payment ? BanknotesIcon : CalendarIcon;
    const action = row.action;
    if (action)
      button = {
        label: t(
          action.kind === "contact_guest"
            ? "notifications.action.contactGuest"
            : "notifications.action.viewBooking",
        ),
        run: () => actions.act(row.key, row.read, action),
      };
  }

  const cta = button;
  return (
    <div
      role={sticky ? "alert" : "status"}
      data-testid="notification-toast"
      className="hidden gap-3 rounded-xl border border-gray-200 bg-white py-3.5 pl-3.5 pr-3 shadow-[0_12px_28px_rgba(17,24,39,0.16)] last:flex md:flex"
    >
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tile}`}>
        <Icon className="h-[17px] w-[17px]" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-semibold text-gray-900">{title}</p>
        <p className="text-[13px] leading-[18px] text-gray-700">{detail}</p>
        {cta && (
          <button
            type="button"
            onClick={() => {
              cta.run();
              onClose();
            }}
            className="mt-1.5 self-start text-[13px] font-semibold text-primary-600 hover:text-primary-700"
          >
            {cta.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={t("notifications.toast.dismiss")}
        className="h-4 w-4 shrink-0 text-gray-400 hover:text-gray-600"
      >
        <XMarkIcon className="h-4 w-4" />
      </button>
    </div>
  );
}
