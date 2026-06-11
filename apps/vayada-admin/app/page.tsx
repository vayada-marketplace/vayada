"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authService } from "@/services/auth";

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    authService.ensureSession().then((authorized) => {
      if (cancelled) return;
      router.push(authorized ? "/dashboard" : "/login");
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <p className="text-gray-600">Redirecting...</p>
      </div>
    </div>
  );
}
