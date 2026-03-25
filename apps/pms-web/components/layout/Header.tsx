'use client'

import { useState, useRef, useEffect } from 'react'
import { authService } from '@/services/auth'
import { bookingsService } from '@/services/bookings'
import SearchModal from './SearchModal'

interface DayStats {
  arrivals: number
  departures: number
}

export default function Header() {
  const [profileOpen, setProfileOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [userName, setUserName] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [stats, setStats] = useState<DayStats>({ arrivals: 0, departures: 0 })
  const profileRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen(prev => !prev)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    setUserName(localStorage.getItem('userName') || '')
    setUserEmail(localStorage.getItem('userEmail') || '')
  }, [])

  useEffect(() => {
    const today = new Date().toISOString().split('T')[0]

    bookingsService.list({ status: 'confirmed', limit: 500 })
      .then((bookingsRes) => {
        const bookings = bookingsRes.bookings
        const arrivals = bookings.filter(b => b.checkIn === today).length
        const departures = bookings.filter(b => b.checkOut === today).length
        setStats({ arrivals, departures })
      })
      .catch(console.error)
  }, [])

  const initials = userName
    ? userName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    : '?'

  const today = new Date()
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })

  return (
    <header className="h-12 bg-white border-b border-gray-200 flex items-center px-4 shrink-0 gap-3">
      {/* Left: date + daily summary */}
      <div className="flex flex-col justify-center w-44 shrink-0">
        <p className="text-[12px] font-semibold text-gray-900 leading-tight">{dateStr}</p>
        <p className="text-[10px] text-gray-400 leading-tight">
          {stats.arrivals} arrivals · {stats.departures} departures
        </p>
      </div>

      {/* Center: search */}
      <div className="flex-1 flex justify-center">
        <button
          onClick={() => setSearchOpen(true)}
          className="w-full max-w-md flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 h-8 cursor-text hover:border-gray-300 transition-colors"
        >
          <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <span className="flex-1 text-left text-[13px] text-gray-400">Search reservations, guests, rooms...</span>
          <kbd className="text-[10px] border border-gray-200 rounded px-1 py-0.5 bg-white text-gray-400 leading-none">⌘K</kbd>
        </button>
      </div>

      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />

      {/* Right: stats + bell + avatar */}
      <div className="flex items-center gap-3 shrink-0">
        {/* Profile avatar */}
        <div className="relative" ref={profileRef}>
          <button
            onClick={() => setProfileOpen(!profileOpen)}
            className="w-7 h-7 bg-primary-600 rounded-full flex items-center justify-center text-white text-[10px] font-semibold hover:bg-primary-700 transition-colors"
          >
            {initials}
          </button>

          {profileOpen && (
            <div className="absolute top-full right-0 mt-1.5 w-52 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1">
              <div className="px-3.5 py-2.5">
                <p className="text-[13px] font-semibold text-gray-900">{userName || 'User'}</p>
                <p className="text-xs text-gray-500">{userEmail}</p>
              </div>
              <div className="border-t border-gray-100" />
              <div className="py-1">
                <button
                  onClick={() => authService.logout()}
                  className="w-full text-left px-3.5 py-2 text-[13px] text-red-500 hover:bg-red-50 transition-colors"
                >
                  Sign Out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
