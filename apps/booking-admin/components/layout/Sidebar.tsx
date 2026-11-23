"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDownIcon, CheckIcon, Cog6ToothIcon } from "@heroicons/react/24/outline";
import { useFeatureModuleActivations, visibleNavModules } from "@vayada/feature-hub";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import { moduleActivationClient } from "@/services/api/moduleActivationClient";
import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";
import { getAuthCsrfToken } from "@/services/auth/sessionStore";
import {
  createBrowserAuthHandoff,
  crossAppReauthenticationUrl,
  type BrowserAuthSurface,
} from "@vayada/product-onboarding";

type Product = "booking" | "pms";

const PMS_FRONTEND_URL = process.env.NEXT_PUBLIC_PMS_FRONTEND_URL || "https://pms.vayada.com";

interface NavItem {
  labelKey?: string;
  label?: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

const coreNavItems: NavItem[] = [
  { labelKey: "layout.sidebar.dashboard", href: "/", icon: DashboardIcon },
  { labelKey: "layout.sidebar.designStudio", href: "/design-studio", icon: DesignStudioIcon },
];

// Feature Hub module items keep the labels of their pages (VAY-2200).
const MODULE_LABEL_KEYS: Record<string, string> = {
  "add-ons": "bookingFlow.tabs.addons",
  promos: "bookingFlow.tabs.promos",
};

// The sidebar's collapsed/expanded choice, kept across pages and reloads (VAY-2593).
const COLLAPSED_STORAGE_KEY = "vayada.bookingAdmin.sidebarCollapsed";

function storedCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

const settingsNavItem: NavItem = {
  labelKey: "layout.sidebar.settings",
  href: "/settings",
  icon: Cog6ToothIcon,
};

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  // The app layout renders the sidebar only in the browser, after sign-in, so this can read storage.
  const [collapsed, setCollapsed] = useState(storedCollapsed);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [enabledProducts, setEnabledProducts] = useState<Set<Product>>(
    () => new Set<Product>(["booking"]),
  );
  const switcherRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const { activeModuleIds, supportedModuleIds } =
    useFeatureModuleActivations(moduleActivationClient);
  // Add-ons and Promos stay listed unless Feature Hub says they are off (VAY-2200).
  const moduleNavItems: NavItem[] = visibleNavModules(
    "booking_engine",
    activeModuleIds,
    supportedModuleIds,
  ).map((module) => ({ ...module.navItem!, labelKey: MODULE_LABEL_KEYS[module.id] }));
  const navItems = [...coreNavItems, ...moduleNavItems, settingsNavItem];

  const switchApp = async (
    baseUrl: string,
    targetSurface: BrowserAuthSurface,
    targetPath: string,
  ) => {
    setSwitchError(null);
    setShowSwitcher(false);
    const csrfToken = getAuthCsrfToken();
    if (csrfToken) {
      try {
        window.location.href = await createBrowserAuthHandoff({
          csrfToken,
          sourceSurface: "booking-admin",
          targetPath,
          targetSurface,
        });
        return;
      } catch {
        // Require target-app authentication when the one-time exchange is unavailable.
      }
    }
    try {
      window.location.href = crossAppReauthenticationUrl(baseUrl, targetPath);
    } catch {
      setSwitchError(t("admin.weCouldnTOpenThatAppPleaseTryAgainLater"));
    }
  };

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    setShowSwitcher(false);
    try {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(next));
    } catch {
      // Storage off or full: the choice lasts until the page reloads.
    }
  };
  const toggleLabel = collapsed
    ? t("layout.sidebar.expandSidebar")
    : t("layout.sidebar.collapseSidebar");

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setShowSwitcher(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void sharedHotelSetupApi
      .getStatus({ entryProduct: "booking" })
      .then((status) => {
        if (!cancelled) {
          setEnabledProducts(
            new Set<Product>([
              "booking",
              ...status.organization.tracks.flatMap((track) =>
                track.components
                  .filter((component) => component.access === "active")
                  .map((component) => component.product)
                  // VAY-2260: the Marketplace is gone; only the two hotel products switch.
                  .filter(
                    (product): product is Product => product === "booking" || product === "pms",
                  ),
              ),
            ]),
          );
        }
      })
      .catch(() => {
        // Keep the current product available when account status cannot be loaded.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    // VAY-2593: 240px wide so the header keeps "Booking Engine" on one line beside the toggle.
    // Collapsing applies from lg up only: below it the sidebar is the menu drawer, which floats
    // over the page and always opens in full.
    <aside
      className={cn(
        "h-full overflow-hidden bg-white border-r border-gray-200 flex flex-col shrink-0 transition-all duration-200",
        collapsed ? "w-60 lg:w-16" : "w-60",
      )}
    >
      {/* App Switcher */}
      <div className="relative border-b border-gray-200 shrink-0" ref={switcherRef}>
        <div
          className={cn("h-12 flex items-center pr-2", collapsed && "lg:justify-center lg:pr-0")}
        >
          <button
            onClick={() => setShowSwitcher(!showSwitcher)}
            className={cn(
              "h-full min-w-0 flex-1 px-3 flex items-center gap-2.5 hover:bg-gray-50 transition-colors",
              collapsed && "lg:hidden",
            )}
          >
            <div className="w-7 h-7 bg-primary-500 rounded-md flex items-center justify-center shrink-0">
              <svg
                width="14"
                height="14"
                viewBox="0 0 18 18"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <rect x="2" y="3" width="14" height="12" rx="2" stroke="white" strokeWidth="1.5" />
                <path d="M2 7H16" stroke="white" strokeWidth="1.5" />
                <path d="M6 3V1" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M12 3V1" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
            <div className="min-w-0 text-left flex-1">
              <p className="text-xs font-semibold text-gray-900 leading-tight">
                {t("layout.sidebar.bookingEngine")}
              </p>
              <p className="text-[10px] text-gray-500 leading-tight truncate">
                {t("layout.sidebar.bookingEngineDescription")}
              </p>
            </div>
            <ChevronDownIcon
              className={cn(
                "w-3.5 h-3.5 text-gray-400 shrink-0 transition-transform",
                showSwitcher && "rotate-180",
              )}
            />
          </button>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={toggleLabel}
            title={toggleLabel}
            className="shrink-0 w-8 h-8 hidden lg:flex items-center justify-center rounded-md border border-gray-200 text-gray-500 hover:text-gray-900 hover:bg-gray-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            <SidebarToggleIcon collapsed={collapsed} className="w-[18px] h-[18px]" />
          </button>
        </div>

        {switchError && (
          <p className="px-3 py-2 text-xs text-red-600" role="alert">
            {switchError}
          </p>
        )}

        {showSwitcher && (
          <div className="absolute top-full left-2 right-2 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1.5">
            <p className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
              <svg
                className="w-3 h-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
              </svg>
              {t("layout.sidebar.switchApp")}
            </p>
            <button
              onClick={() => setShowSwitcher(false)}
              className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 transition-colors w-full"
            >
              <div className="w-7 h-7 bg-primary-500 rounded-md flex items-center justify-center shrink-0">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 18 18"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <rect
                    x="2"
                    y="3"
                    width="14"
                    height="12"
                    rx="2"
                    stroke="white"
                    strokeWidth="1.5"
                  />
                  <path d="M2 7H16" stroke="white" strokeWidth="1.5" />
                  <path d="M6 3V1" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M12 3V1" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </div>
              <div className="min-w-0 flex-1 text-left">
                <p className="text-xs font-medium text-gray-900 leading-tight">
                  {t("layout.sidebar.bookingEngine")}
                </p>
                <p className="text-[10px] text-gray-500 leading-tight">
                  {t("layout.sidebar.bookingEngineDescription")}
                </p>
              </div>
              <CheckIcon className="w-4 h-4 text-primary-500 shrink-0" />
            </button>
            {enabledProducts.has("pms") && (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  void switchApp(PMS_FRONTEND_URL, "pms-web", "/dashboard");
                }}
                className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 transition-colors"
              >
                <div className="w-7 h-7 bg-emerald-600 rounded-md flex items-center justify-center shrink-0">
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="white"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7" />
                    <path d="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
                    <path d="M3 7h18" />
                    <path d="M8 11h8" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-gray-900 leading-tight">
                    {t("layout.sidebar.propertyManager")}
                  </p>
                  <p className="text-[10px] text-gray-500 leading-tight">
                    {t("layout.sidebar.propertyManagerDescription")}
                  </p>
                </div>
              </a>
            )}
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav aria-label="Main" className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const label = item.labelKey ? t(item.labelKey) : item.label || "";
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] transition-colors",
                isActive
                  ? "text-gray-900 font-semibold bg-gray-50"
                  : "text-gray-600 hover:text-gray-900 hover:bg-gray-50",
                collapsed && "lg:justify-center lg:px-0",
              )}
              title={collapsed ? label : undefined}
            >
              <item.icon
                className={cn(
                  "w-[18px] h-[18px] shrink-0",
                  isActive ? "text-gray-900" : "text-gray-400",
                )}
              />
              <span className={cn(collapsed && "lg:hidden")}>{label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

/* Custom icon components matching the screenshot */

/** A side panel with a chevron: left to collapse, right to expand (VAY-2593). */
function SidebarToggleIcon({ collapsed, className }: { collapsed: boolean; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d={collapsed ? "M13.5 10l2 2-2 2" : "M15.5 10l-2 2 2 2"} />
    </svg>
  );
}

function DashboardIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function DesignStudioIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M3 12h4" />
      <path d="M17 12h4" />
    </svg>
  );
}
