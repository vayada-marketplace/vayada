"use client";

import { createContext, useContext } from "react";
import type { PmsSelfAccess } from "@/services/api/pmsStaffClient";

const PmsAccessContext = createContext<PmsSelfAccess | null>(null);

export function PmsAccessProvider({
  access,
  children,
}: {
  access: PmsSelfAccess;
  children: React.ReactNode;
}) {
  return <PmsAccessContext.Provider value={access}>{children}</PmsAccessContext.Provider>;
}

export function usePmsAccess(): PmsSelfAccess {
  const access = useContext(PmsAccessContext);
  if (!access) throw new Error("PMS access was not loaded");
  return access;
}

/** Whether this member holds `permission`. Settings saves check the same key in the API, so a page
 * shows a section read-only, or not at all, when the role lacks it (VAY-2154). */
export function useHasPmsPermission(permission: string): boolean {
  return usePmsAccess().permissions.includes(permission);
}
