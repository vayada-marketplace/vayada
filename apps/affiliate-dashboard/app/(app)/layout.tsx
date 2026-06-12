"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import SWRProvider from "@/components/SWRProvider";
import { authService } from "@/services/auth";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [isAuthorized, setIsAuthorized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authService.ensureSession().then((authorized) => {
      if (cancelled) return;
      if (authorized) {
        setIsAuthorized(true);
      } else {
        router.push("/login?expired=true");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!isAuthorized) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <div className="text-gray-500 text-sm">Loading dashboard...</div>
      </div>
    );
  }

  return <SWRProvider>{children}</SWRProvider>;
}
