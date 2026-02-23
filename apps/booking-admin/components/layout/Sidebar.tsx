'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  ChevronLeftIcon,
  ChevronDownIcon,
  CheckIcon,
  Cog6ToothIcon,
} from '@heroicons/react/24/outline'
import { cn } from '@/lib/utils'

const PMS_FRONTEND_URL = process.env.NEXT_PUBLIC_PMS_FRONTEND_URL || 'https://pms.vayada.com'

const navItems = [
  {
    label: 'Dashboard',
    href: '/',
    icon: DashboardIcon,
  },
  {
    label: 'Design Studio',
    href: '/design-studio',
    icon: DesignStudioIcon,
  },
  {
    label: 'Settings',
    href: '/settings',
    icon: Cog6ToothIcon,
  },
]

export default function Sidebar() {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const [showSwitcher, setShowSwitcher] = useState(false)
  const switcherRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setShowSwitcher(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  return (
    <aside
      className={cn(
        'h-full bg-white border-r border-gray-200 flex flex-col shrink-0 transition-all duration-200',
        collapsed ? 'w-14' : 'w-52'
      )}
    >
      {/* App Switcher */}
      <div className="relative border-b border-gray-200 shrink-0" ref={switcherRef}>
        <button
          onClick={() => !collapsed && setShowSwitcher(!showSwitcher)}
          className={cn(
            'h-12 w-full px-3 flex items-center gap-2.5 hover:bg-gray-50 transition-colors',
            collapsed && 'justify-center px-0'
          )}
        >
          <div className="w-7 h-7 bg-primary-500 rounded-md flex items-center justify-center shrink-0">
            <svg width="14" height="14" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="2" y="3" width="14" height="12" rx="2" stroke="white" strokeWidth="1.5" />
              <path d="M2 7H16" stroke="white" strokeWidth="1.5" />
              <path d="M6 3V1" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M12 3V1" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          {!collapsed && (
            <>
              <div className="min-w-0 text-left flex-1">
                <p className="text-xs font-semibold text-gray-900 leading-tight">Booking Engine</p>
                <p className="text-[10px] text-gray-500 leading-tight truncate">Direct bookings & revenue</p>
              </div>
              <ChevronDownIcon className={cn('w-3.5 h-3.5 text-gray-400 shrink-0 transition-transform', showSwitcher && 'rotate-180')} />
            </>
          )}
        </button>

        {showSwitcher && !collapsed && (
          <div className="absolute top-full left-2 right-2 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1.5">
            <p className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
              </svg>
              Switch App
            </p>
            <button
              onClick={() => setShowSwitcher(false)}
              className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 transition-colors w-full"
            >
              <div className="w-7 h-7 bg-primary-500 rounded-md flex items-center justify-center shrink-0">
                <svg width="12" height="12" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="2" y="3" width="14" height="12" rx="2" stroke="white" strokeWidth="1.5" />
                  <path d="M2 7H16" stroke="white" strokeWidth="1.5" />
                  <path d="M6 3V1" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M12 3V1" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </div>
              <div className="min-w-0 flex-1 text-left">
                <p className="text-xs font-medium text-gray-900 leading-tight">Booking Engine</p>
                <p className="text-[10px] text-gray-500 leading-tight">Direct bookings & revenue</p>
              </div>
              <CheckIcon className="w-4 h-4 text-primary-500 shrink-0" />
            </button>
            <a
              href={PMS_FRONTEND_URL}
              className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 transition-colors"
            >
              <div className="w-7 h-7 bg-emerald-600 rounded-md flex items-center justify-center shrink-0">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7" />
                  <path d="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
                  <path d="M3 7h18" />
                  <path d="M8 11h8" />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-gray-900 leading-tight">Property Manager</p>
                <p className="text-[10px] text-gray-500 leading-tight">Operations & inventory</p>
              </div>
            </a>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
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

