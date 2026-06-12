"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/layout/Header";
import Sidebar from "@/components/layout/Sidebar";
import { authService } from "@/services/auth";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authService.ensureSession().then((authorized) => {
      if (cancelled) return;
      if (!authorized || !authService.isHotelAdmin()) {
        router.replace("/login");
      } else {
        setIsAuthorized(true);
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
