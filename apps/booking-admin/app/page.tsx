"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authService } from "@/services/auth";
import { resolveBookingSetupGuard } from "@/lib/utils/sharedSetupGuard";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    async function redirect() {
      const authorized = await authService.ensureSession();
      if (cancelled) return;
      if (authorized && authService.isHotelAdmin()) {
        const decision = await resolveBookingSetupGuard("/dashboard");
        if (cancelled) return;
        localStorage.setItem(
          "setupComplete",
          decision.action === "enter_product" ? "true" : "false",
        );
        router.replace(decision.action === "enter_product" ? "/dashboard" : decision.redirectPath);
      } else {
        router.replace("/login");
      }
    }
    redirect();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return null;
}
