"use client";

import { useState, useEffect, createContext, useContext } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { ROUTES, STORAGE_KEYS } from "@/lib/constants";
import { authService } from "@/services/auth";
import { HotelIcon, ProfileIcon, CalendarIcon, MessageIcon } from "@/components/ui";
import { ArrowRightOnRectangleIcon, ViewColumnsIcon } from "@heroicons/react/24/outline";
import { AppSwitcher } from "./AppSwitcher";

// Context for sidebar collapsed state
const SidebarContext = createContext<{
  isCollapsed: boolean;
  toggleSidebar: () => void;
}>({
  isCollapsed: true,
  toggleSidebar: () => {},
});

export const useSidebar = () => useContext(SidebarContext);

export default function AuthenticatedNavigation() {
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(true);

  // Load collapsed state from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.SIDEBAR_COLLAPSED);
    if (saved !== null) {
      setIsCollapsed(JSON.parse(saved));
    } else {
      // Default to collapsed if no saved preference
      setIsCollapsed(true);
    }
  }, []);

  // Save collapsed state to localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.SIDEBAR_COLLAPSED, JSON.stringify(isCollapsed));
  }, [isCollapsed]);

  const toggleSidebar = () => {
    setIsCollapsed(!isCollapsed);
  };

  const handleLogout = () => {
    authService.logout();
    // authService.logout() already redirects to /login, so no need to push here
  };

  const isActive = (path: string) => pathname === path;

  const navLinks = [
    {
      href: ROUTES.MARKETPLACE,
      label: "Marketplace",
      icon: HotelIcon,
    },
    {
      href: ROUTES.CALENDAR,
      label: "Calendar",
      icon: CalendarIcon,
    },
    {
      href: ROUTES.CHAT,
      label: "Messages",
      icon: MessageIcon,
    },
    {
      href: ROUTES.PROFILE,
      label: "My Profile",
      icon: ProfileIcon,
    },
  ];

  return (
    <SidebarContext.Provider value={{ isCollapsed, toggleSidebar }}>
      {/* Backdrop overlay when sidebar is expanded on mobile - click to collapse */}
      {!isCollapsed && (
        <div className="fixed inset-0 bg-black/40 z-40 md:hidden" onClick={toggleSidebar} />
      )}

      {/* Sidebar - Hidden on small screens when collapsed, visible when expanded or on larger screens */}
      <aside
        className={`fixed left-0 top-0 bottom-0 bg-white border-r border-gray-200 flex-col z-50 transition-all duration-200 ${
          isCollapsed ? "w-14" : "w-52"
        } ${
          isCollapsed
            ? "hidden md:flex" // Hidden on small screens when collapsed, visible on larger screens
            : "flex" // Always visible when expanded
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sidebar Logo */}
        <div className="h-12 flex items-center justify-center border-b border-gray-200">
          <Link
            href={ROUTES.MARKETPLACE}
            className="flex items-center justify-center transition-opacity hover:opacity-80"
          >
            <Image
              src="/vayada-logo-navbar.png"
              alt="vayada"
              width={isCollapsed ? 28 : 96}
              height={28}
              className={`object-contain transition-all duration-200 ${isCollapsed ? "w-7 h-7" : "h-7 w-auto"}`}
              priority
            />
          </Link>
        </div>

        {/* App Switcher — lets hotel users hop back to PMS / Booking Engine. */}
        <AppSwitcher isCollapsed={isCollapsed} />

        {/* Navigation Links */}
        <nav className="flex-1 p-2.5 space-y-1 overflow-y-auto">
          {navLinks.map((link) => {
            const Icon = link.icon;
            const active = isActive(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`flex items-center rounded-md text-[13px] font-medium transition-colors ${
                  isCollapsed ? "justify-center px-2 py-2.5" : "gap-2.5 px-3 py-2.5"
                } ${
                  active
                    ? "bg-gray-100 text-gray-950"
                    : "text-gray-500 hover:bg-gray-50 hover:text-gray-900"
                }`}
                title={isCollapsed ? link.label : undefined}
              >
                <Icon className="w-5 h-5 flex-shrink-0" />
                {!isCollapsed && <span className="text-sm">{link.label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* Logout Button - Bottom Left */}
        <div className="mt-auto p-2.5 border-t border-gray-200">
          <button
            onClick={handleLogout}
            className={`flex items-center rounded-md text-[13px] font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-900 transition-colors w-full ${
              isCollapsed ? "justify-center px-2 py-2.5" : "gap-2.5 px-3 py-2.5 justify-start"
            }`}
            title={isCollapsed ? "Sign Out" : undefined}
          >
            <ArrowRightOnRectangleIcon className="w-5 h-5 flex-shrink-0" />
            {!isCollapsed && <span className="text-sm">Sign Out</span>}
          </button>
        </div>
      </aside>

      {/* Top Header - Visible on all screen sizes */}
      <header
        className={`fixed top-0 left-0 right-0 h-12 bg-white border-b border-gray-200 z-40 transition-all duration-200 ${
          isCollapsed ? "md:pl-14" : "md:pl-52"
        }`}
      >
        <div className="flex items-center justify-between h-full w-full px-3 md:px-4">
          <div className="flex items-center gap-3">
            <button
              onClick={toggleSidebar}
              className="p-2 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 transition-colors"
              title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <ViewColumnsIcon className="w-5 h-5" />
            </button>
            <div className="hidden sm:block">
              <p className="text-sm font-semibold leading-tight text-gray-950">Marketplace</p>
              <p className="text-[11px] leading-tight text-gray-500">Creator collaborations</p>
            </div>
          </div>

          <Link
            href={ROUTES.MARKETPLACE}
            className="text-sm font-semibold text-gray-900 transition-colors hover:text-primary-700"
          >
            vayada
          </Link>
        </div>
      </header>
    </SidebarContext.Provider>
  );
}
