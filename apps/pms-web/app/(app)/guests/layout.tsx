"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { useGuestsSectionOn } from "@/lib/guests/useGuestsSectionOn";

/** With Guests switched off in Feature Hub, its pages send staff to the Dashboard (VAY-2423). */
export default function GuestsLayout({ children }: { children: ReactNode }) {
  const on = useGuestsSectionOn();
  const router = useRouter();
  useEffect(() => {
    if (!on) router.replace("/dashboard");
  }, [on, router]);
  return on ? <>{children}</> : null;
}
