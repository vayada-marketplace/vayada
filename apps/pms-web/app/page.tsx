"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authService } from "@/services/auth";
import { checkPmsSetupStatus } from "@/lib/utils/setupStatus";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    async function redirect() {
      const authorized = await authService.ensureSession();
      if (cancelled) return;
      if (!authorized || !authService.isHotelAdmin()) {
        router.replace("/login");
        return;
      }

      const status = await checkPmsSetupStatus();
      if (cancelled) return;

      if (!status || !status.registered) {
        // Not registered in PMS — send to booking engine onboarding
        router.replace("/login");
        return;
      }

      if (!status.setupComplete) {
        router.replace("/setup");
      } else {
        router.replace("/dashboard");
      }
    }
    redirect();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return null;
}
