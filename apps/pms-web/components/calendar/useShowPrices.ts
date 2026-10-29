"use client";

import { useCallback, useEffect, useState } from "react";
import { getAuthSessionUser } from "@/services/auth/sessionStore";

const STORAGE_KEY = "pms.calendar.showPrices";
// Per signed-in user on this browser (VAY-2411): a display choice needs no server setting.
const storageKey = () =>
  `${STORAGE_KEY}:${getAuthSessionUser()?.id ?? window.localStorage.getItem("userId") ?? ""}`;

/** The calendar's "Show prices" switch: on unless this user turned it off. */
export function useShowPrices(): [boolean, (on: boolean) => void] {
  const [showPrices, setShowPrices] = useState(true);
  useEffect(() => {
    try {
      setShowPrices(window.localStorage.getItem(storageKey()) !== "off");
    } catch {
      // localStorage may be unavailable (private mode): prices stay on.
    }
  }, []);
  const change = useCallback((on: boolean) => {
    setShowPrices(on);
    try {
      window.localStorage.setItem(storageKey(), on ? "on" : "off");
    } catch {
      // The switch still works for this visit.
    }
  }, []);
  return [showPrices, change];
}
