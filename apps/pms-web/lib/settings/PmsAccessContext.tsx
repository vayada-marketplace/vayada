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
