"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authService } from "@/services/auth";
import { isSetupComplete } from "@/lib/utils/setupStatus";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    async function redirect() {
      const authorized = await authService.ensureSession();
      if (cancelled) return;
      if (authorized && authService.isHotelAdmin()) {
        const complete = await isSetupComplete();
        if (cancelled) return;
        router.replace(complete ? "/dashboard" : "/setup");
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
