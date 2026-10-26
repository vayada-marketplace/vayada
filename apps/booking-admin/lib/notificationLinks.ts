"use client";

import { useEffect, useRef } from "react";

/** Links from the notifications bell (VAY-2349) into Reservations (?search=reference) and Promos (?edit=id).
 * When that page is already open the router isn't used: Next 16 keeps a cached URL for the same static route,
 * so the link updates the address itself and tells the page. */
export type NotificationLinkTarget =
  | { path: "/reservations"; param: "search" }
  | { path: "/promo-codes"; param: "edit" };

const EVENT = "booking-admin:notification-link";

export function notificationLinkHref(target: NotificationLinkTarget, value: string): string {
  return `${target.path}?${target.param}=${encodeURIComponent(value)}`;
}

export function openNotificationLink(
  target: NotificationLinkTarget,
  value: string,
  push: (href: string) => void,
): void {
  const href = notificationLinkHref(target, value);
  if (window.location.pathname.replace(/\/$/, "") !== target.path) {
    push(href);
    return;
  }
  window.history.pushState(null, "", href);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { ...target, value } }));
}

/** Calls onValue with the link's value when the page opens from one, or when a link to it is followed while
 * it is open. */
export function useNotificationLink(
  target: NotificationLinkTarget,
  onValue: (value: string) => void,
): void {
  const callback = useRef(onValue);
  useEffect(() => {
    callback.current = onValue;
  });
  const { path, param } = target;
  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get(param)?.trim();
    if (initial) callback.current(initial);
    const onLink = (event: Event) => {
      const detail = (event as CustomEvent<{ path: string; param: string; value: string }>).detail;
      if (detail?.path === path && detail.param === param && detail.value)
        callback.current(detail.value);
    };
    window.addEventListener(EVENT, onLink);
    return () => window.removeEventListener(EVENT, onLink);
  }, [path, param]);
}
