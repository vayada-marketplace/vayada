"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authService } from "@/services/auth";
import Sidebar from "@/components/layout/Sidebar";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
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
    return null;
  }

  return (
    <div className="h-screen flex">
      <Sidebar />
      <main className="flex-1 overflow-auto bg-gray-50">{children}</main>
    </div>
  );
}
