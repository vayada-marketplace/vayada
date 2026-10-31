"use client";

import { useEffect, useState } from "react";

import { pmsNavigationModuleClient } from "@/services/api/pmsNavigationModuleClient";

type NavigationModules = { activeModules?: unknown; supportedModules?: unknown };

/** Guests is on unless the switch read says it is off; an API that doesn't know the switch
 * yet, or a malformed read, leaves it on (VAY-2423). */
export function guestsSectionOn(modules: NavigationModules | null | undefined): boolean {
  const active = modules?.activeModules;
  const supported = modules?.supportedModules;
  if (!Array.isArray(active) || !Array.isArray(supported)) return true;
  return active.includes("guests") || !supported.includes("guests");
}

/**
 * Whether the property's Guests section is switched on in Feature Hub (VAY-2423). On until a read
 * says otherwise, so a slow or failed read never hides it.
 */
export function useGuestsSectionOn(): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    let sequence = 0;
    const refresh = () => {
      const current = ++sequence;
      void pmsNavigationModuleClient
        .list()
        .then((response) => {
          if (current === sequence) setOn(guestsSectionOn(response));
        })
        .catch(() => {
          if (current === sequence) setOn(true);
        });
    };
    refresh();
    // The Feature Hub announces every switch.
    window.addEventListener("vayada-feature-modules-changed", refresh);
    return () => {
      sequence += 1;
      window.removeEventListener("vayada-feature-modules-changed", refresh);
    };
  }, []);
  return on;
}
