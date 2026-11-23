import { useSyncExternalStore } from "react";
import { DEFAULT_TIME_RANGE, type TimeRange } from "@/services/dashboard";

// The Dashboard's date range, which the header strip follows on every page (VAY-2594). It lasts
// for this visit only, so the Dashboard opens on the last 30 days again after a reload.
let current: TimeRange = DEFAULT_TIME_RANGE;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setDashboardRange(range: TimeRange): void {
  if (range === current) return;
  current = range;
  listeners.forEach((listener) => listener());
}

export function useDashboardRange(): TimeRange {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_TIME_RANGE,
  );
}
