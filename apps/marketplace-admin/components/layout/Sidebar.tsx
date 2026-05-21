"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { authService } from "@/services/auth";

const navItems = [
  { label: "Dashboard", href: "/dashboard/kpis", icon: DashboardIcon },
  { label: "Users", href: "/dashboard", icon: UsersIcon },
  { label: "Hotels", href: "/dashboard/hotels", icon: HotelsIcon },
  { label: "Bookings", href: "/dashboard/bookings", icon: BookingsIcon },
  { label: "Marketplace", href: "/dashboard/marketplace", icon: MarketplaceIcon },
  { label: "Collaborations", href: "/dashboard/collaborations", icon: CollaborationsIcon },
  { label: "Invite Codes", href: "/dashboard/invite-codes", icon: InviteCodesIcon },
  { label: "Affiliate Payouts", href: "/dashboard/affiliate-payouts", icon: AffiliatePayoutsIcon },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);

  const handleLogout = () => {
    authService.logout();
    router.push("/login");
  };

  return (
    <aside
      className={`h-full bg-white border-r border-gray-200 flex flex-col shrink-0 transition-all duration-200 ${
        collapsed ? "w-14" : "w-52"
      }`}
    >
      {/* Branding */}
      <div className="h-12 border-b border-gray-200 flex items-center px-3 shrink-0">
        <div className="w-7 h-7 bg-gray-900 rounded-md flex items-center justify-center shrink-0">
          <span className="text-white text-xs font-bold">V</span>
        </div>
        {!collapsed && (
          <div className="ml-2.5 min-w-0">
            <p className="text-xs font-semibold text-gray-900 leading-tight">vayada</p>
            <p className="text-[10px] text-gray-500 leading-tight">Admin Dashboard</p>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const isActive =
            item.href === "/dashboard"
              ? pathname === "/dashboard" || pathname.startsWith("/dashboard/users")
              : pathname === item.href ||
                (item.href !== "/dashboard/kpis" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] transition-colors ${
                isActive
                  ? "text-gray-900 font-semibold bg-gray-50"
                  : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
              } ${collapsed ? "justify-center px-0" : ""}`}
              title={collapsed ? item.label : undefined}
            >
              <item.icon
                className={`w-[18px] h-[18px] shrink-0 ${
                  isActive ? "text-gray-900" : "text-gray-400"
                }`}
              />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="px-2 pb-2 space-y-0.5">
        <button
          onClick={handleLogout}
          className={`flex items-center gap-2.5 w-full px-2.5 py-2 text-[13px] text-gray-600 hover:text-gray-900 rounded-md hover:bg-gray-50 transition-colors ${
            collapsed ? "justify-center px-0" : ""
          }`}
          title={collapsed ? "Logout" : undefined}
        >
          <LogoutIcon className="w-[18px] h-[18px] shrink-0 text-gray-400" />
          {!collapsed && <span>Logout</span>}
        </button>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={`flex items-center gap-2 w-full px-2.5 py-1.5 text-[13px] text-gray-500 hover:text-gray-700 rounded-md hover:bg-gray-50 transition-colors ${
            collapsed ? "justify-center px-0" : ""
          }`}
        >
          <svg
            className={`w-3.5 h-3.5 transition-transform ${collapsed ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 19l-7-7 7-7" />
          </svg>
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}

function UsersIcon({ className }: { className?: string }) {
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
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87" />
      <path d="M16 3.13a4 4 0 010 7.75" />
    </svg>
  );
}

function HotelsIcon({ className }: { className?: string }) {
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
      <path d="M3 21h18" />
      <path d="M5 21V7l8-4v18" />
      <path d="M19 21V11l-6-4" />
      <path d="M9 9h1" />
      <path d="M9 13h1" />
      <path d="M9 17h1" />
    </svg>
  );
}

function MarketplaceIcon({ className }: { className?: string }) {
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
      <path d="M6 2L3 7v13a2 2 0 002 2h14a2 2 0 002-2V7l-3-5z" />
      <path d="M3 7h18" />
      <path d="M16 11a4 4 0 01-8 0" />
    </svg>
  );
}

function CollaborationsIcon({ className }: { className?: string }) {
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
      <path d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
    </svg>
  );
}

function InviteCodesIcon({ className }: { className?: string }) {
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
      <path d="M15 5v2m0 4v2m0 4v2" />
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 12h18" />
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

function BookingsIcon({ className }: { className?: string }) {
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
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18" />
      <path d="M8 14h4" />
    </svg>
  );
}

function AffiliatePayoutsIcon({ className }: { className?: string }) {
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
      <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
    </svg>
  );
}

function LogoutIcon({ className }: { className?: string }) {
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
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}
