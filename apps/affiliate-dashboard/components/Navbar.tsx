'use client'

import { ArrowLeftIcon, Bars3Icon, XMarkIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'

interface NavbarProps {
  userName: string
  userInitials: string
}

export default function Navbar({ userName, userInitials }: NavbarProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-4">
            <a
              href="#"
              className="text-primary-600 hover:text-primary-700 text-sm font-medium flex items-center gap-1.5 transition-colors"
            >
              <ArrowLeftIcon className="w-4 h-4" />
              Back to Sundancer Lombok
            </a>
            <span className="hidden sm:inline text-gray-300">|</span>
            <span className="hidden sm:inline text-gray-900 font-semibold text-sm">
              Affiliate Portal
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden sm:inline text-sm text-gray-600">{userName}</span>
            <div className="w-9 h-9 rounded-full bg-primary-800 text-white flex items-center justify-center text-sm font-medium">
              {userInitials}
            </div>
            <button
              className="sm:hidden p-1.5 text-gray-500"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              {mobileMenuOpen ? (
                <XMarkIcon className="w-5 h-5" />
              ) : (
                <Bars3Icon className="w-5 h-5" />
              )}
            </button>
          </div>
        </div>
      </div>

      {mobileMenuOpen && (
        <div className="sm:hidden border-t border-gray-100 bg-white px-4 py-3 space-y-2">
          <a href="#" className="block text-sm text-gray-700 py-1.5">Dashboard</a>
          <a href="#" className="block text-sm text-gray-700 py-1.5">Payouts</a>
          <a href="#" className="block text-sm text-gray-700 py-1.5">Settings</a>
          <a href="#" className="block text-sm text-error-600 py-1.5">Sign out</a>
        </div>
      )}
    </nav>
  )
}
