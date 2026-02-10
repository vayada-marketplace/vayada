'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  ChevronLeftIcon,
  Cog6ToothIcon,
  GlobeAltIcon,
} from '@heroicons/react/24/outline'
import { cn } from '@/lib/utils'

const navItems = [
  {
    label: 'Dashboard',
    href: '/',
    icon: DashboardIcon,
  },
  {
    label: 'Global Demand',
    href: '/global-demand',
    icon: GlobeAltIcon,
  },
  {
    label: 'Integrations',
    href: '/integrations',
    icon: IntegrationsIcon,
  },
  {
    label: 'Design Studio',
    href: '/design-studio',
    icon: DesignStudioIcon,
  },
  {
    label: 'Booking Flow',
    href: '/booking-flow',
    icon: BookingFlowIcon,
  },
  {
    label: 'Settings',
    href: '/dashboard/settings',
    icon: Cog6ToothIcon,
  },
]

export default function Sidebar() {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)

  return (
    <aside
      className={cn(
        'h-full bg-white border-r border-gray-200 flex flex-col shrink-0 transition-all duration-200',
        collapsed ? 'w-14' : 'w-52'
      )}
    >
      {/* Logo / App Identity */}
      <div className="h-12 px-3 flex items-center gap-2.5 border-b border-gray-200 shrink-0">
        <div className="w-7 h-7 bg-primary-500 rounded-md flex items-center justify-center shrink-0">
          <svg width="14" height="14" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="2" y="3" width="14" height="12" rx="2" stroke="white" strokeWidth="1.5" />
            <path d="M2 7H16" stroke="white" strokeWidth="1.5" />
            <path d="M6 3V1" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M12 3V1" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <p className="text-xs font-semibold text-gray-900 leading-tight">Booking Engine</p>
            <p className="text-[10px] text-gray-500 leading-tight truncate">Direct bookings & revenue</p>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] transition-colors',
                isActive
                  ? 'text-gray-900 font-semibold bg-gray-50'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50',
                collapsed && 'justify-center px-0'
              )}
              title={collapsed ? item.label : undefined}
            >
              <item.icon
                className={cn(
                  'w-[18px] h-[18px] shrink-0',
                  isActive ? 'text-gray-900' : 'text-gray-400'
                )}
              />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          )
        })}
      </nav>

      {/* Bottom section */}
      <div className="px-2 pb-2 space-y-1.5">

        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={cn(
            'flex items-center gap-2 w-full px-2.5 py-1.5 text-[13px] text-gray-500 hover:text-gray-700 rounded-md hover:bg-gray-50 transition-colors',
            collapsed && 'justify-center px-0'
          )}
        >
          <ChevronLeftIcon
            className={cn(
              'w-3.5 h-3.5 transition-transform',
              collapsed && 'rotate-180'
            )}
          />
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  )
}

/* Custom icon components matching the screenshot */

function DashboardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}

function IntegrationsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 8V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2" />
      <path d="M7 16v2a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2" />
      <path d="M3 12h4" />
      <path d="M17 12h4" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function DesignStudioIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M3 12h4" />
      <path d="M17 12h4" />
    </svg>
  )
}

function BookingFlowIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="M9 12h6" />
      <path d="M9 16h6" />
    </svg>
  )
}
