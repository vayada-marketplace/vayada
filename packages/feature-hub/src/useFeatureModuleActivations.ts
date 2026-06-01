"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { FeatureActivationClient, ModuleActivationsResponse } from "./types";

const EVENT_NAME = "vayada-feature-modules-changed";
const FALLBACK_STORAGE_KEY = "vayada-feature-modules";

function selectedHotelId(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem("selectedHotelId") || "";
}

function storageKey(hotelId?: string): string {
  return `${FALLBACK_STORAGE_KEY}:${hotelId || selectedHotelId() || "default"}`;
}

function readCached(hotelId?: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(storageKey(hotelId)) || "[]");
  } catch {
    return [];
  }
}

function publish(activeModuleIds: string[], hotelId?: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(storageKey(hotelId), JSON.stringify(activeModuleIds));
  window.dispatchEvent(
    new CustomEvent(EVENT_NAME, {
      detail: { activeModuleIds, hotelId: hotelId || selectedHotelId() || "default" },
    }),
  );
}

export function useFeatureModuleActivations(client: FeatureActivationClient) {
  const [activeModuleIds, setActiveModuleIds] = useState<string[]>(() => readCached());
  const [hotelId, setHotelId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const applyResponse = useCallback((response: ModuleActivationsResponse) => {
    const next = response.activeModules || [];
    setHotelId(response.hotelId);
    setActiveModuleIds(next);
    publish(next, response.hotelId);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await client.list();
      if (!mounted.current) return;
      applyResponse(response);
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : "Could not load feature modules.");
      const cached = readCached();
      if (cached.length > 0) setActiveModuleIds(cached);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [applyResponse, client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { activeModuleIds?: string[]; hotelId?: string }
        | undefined;
      if (!detail?.activeModuleIds) return;
      if (detail.hotelId && hotelId && detail.hotelId !== hotelId) return;
      setActiveModuleIds(detail.activeModuleIds);
    };
    window.addEventListener(EVENT_NAME, onChange);
    return () => window.removeEventListener(EVENT_NAME, onChange);
  }, [hotelId]);

  const setModuleActive = useCallback(
    async (moduleId: string, isActive: boolean) => {
      const previous = activeModuleIds;
      const next = isActive
        ? Array.from(new Set([...activeModuleIds, moduleId]))
        : activeModuleIds.filter((id) => id !== moduleId);
      setActiveModuleIds(next);
      publish(next, hotelId);
      try {
        await client.update(moduleId, isActive);
      } catch (err) {
        setActiveModuleIds(previous);
        publish(previous, hotelId);
        throw err;
      }
    },
    [activeModuleIds, client, hotelId],
  );

  const activeModuleSet = useMemo(() => new Set(activeModuleIds), [activeModuleIds]);

  return {
    activeModuleIds,
    activeModuleSet,
    hotelId,
    loading,
    error,
    refresh,
    setModuleActive,
  };
}
