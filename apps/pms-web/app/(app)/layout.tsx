"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/layout/Header";
import Sidebar from "@/components/layout/Sidebar";
import { authService } from "@/services/auth";
import { resolvePmsSetupGuard } from "@/lib/utils/sharedSetupGuard";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function authorize() {
      try {
        const authorized = await authService.ensureSession();
        if (cancelled) return;
        if (!authorized || !authService.isHotelAdmin()) {
          router.replace(loginPathForCurrentRoute("/dashboard"));
          return;
        }

        const returnTo =
          typeof window === "undefined"
            ? "/dashboard"
            : `${window.location.pathname}${window.location.search}`;
        const decision = await resolvePmsSetupGuard(returnTo);
        if (cancelled) return;
        localStorage.setItem(
          "pmsSetupComplete",
          decision.action === "enter_product" ? "true" : "false",
        );
        if (decision.action === "redirect_to_setup") {
          router.replace(decision.redirectPath);
          return;
        }
        setIsAuthorized(true);
      } catch {
        if (!cancelled) router.replace(loginPathForCurrentRoute("/dashboard"));
      }
    }
    void authorize();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!isAuthorized) {
    return null;
  }

  return (
    // 100dvh (not 100vh): on iOS Safari 100vh ignores the URL bar, so the
    // shell's bottom — and any sticky footers anchored to it — sit behind
    // the browser chrome until Safari collapses it mid-scroll.
    <div className="h-[100dvh] flex overflow-x-hidden">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      {/* Sidebar: hidden on mobile, shown as overlay when open */}
      <div
        className={`fixed inset-y-0 left-0 z-50 lg:static lg:z-auto transition-transform duration-200 ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`}
      >
        <Sidebar onNavigate={() => setSidebarOpen(false)} />
      </div>
      <div className="flex-1 flex flex-col min-w-0">
        <Header onMenuToggle={() => setSidebarOpen(!sidebarOpen)} />
        <main className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain bg-gray-50">
          {children}
        </main>
      </div>
    </div>
  );
}

function loginPathForCurrentRoute(fallbackReturnTo: string): string {
  const returnTo =
    typeof window === "undefined"
      ? fallbackReturnTo
      : `${window.location.pathname}${window.location.search}`;
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}
