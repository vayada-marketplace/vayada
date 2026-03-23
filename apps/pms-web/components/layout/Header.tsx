'use client'

import { useState, useRef, useEffect } from 'react'
import { authService } from '@/services/auth'
import { roomsService } from '@/services/rooms'
import { bookingsService } from '@/services/bookings'

interface DayStats {
  arrivals: number
  departures: number
  occupancy: number
  revpar: number
}

export default function Header() {
  const [profileOpen, setProfileOpen] = useState(false)
  const [userName, setUserName] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [stats, setStats] = useState<DayStats>({ arrivals: 0, departures: 0, occupancy: 0, revpar: 0 })
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
    setUserName(localStorage.getItem('userName') || '')
    setUserEmail(localStorage.getItem('userEmail') || '')
  }, [])

  useEffect(() => {
    const today = new Date().toISOString().split('T')[0]
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0]

    Promise.all([
      roomsService.list(),
      bookingsService.list({ status: 'confirmed', limit: 500 }),
    ])
      .then(([rooms, bookingsRes]) => {
        const totalRooms = rooms.reduce((sum, r) => sum + r.totalRooms, 0)
        const bookings = bookingsRes.bookings
        const arrivals = bookings.filter(b => b.checkIn === today).length
        const departures = bookings.filter(b => b.checkOut === today).length
        const occupied = bookings.filter(b => b.checkIn <= today && b.checkOut > today).length
        const occupancy = totalRooms > 0 ? Math.round((occupied / totalRooms) * 100) : 0
        const revenue30 = bookings
          .filter(b => b.checkIn >= thirtyDaysAgoStr)
          .reduce((sum, b) => sum + b.totalAmount, 0)
        const revpar = totalRooms > 0 ? Math.round(revenue30 / (totalRooms * 30)) : 0
        setStats({ arrivals, departures, occupancy, revpar })
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
        <div className="w-full max-w-md flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 h-8 cursor-text">
          <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <span className="flex-1 text-[13px] text-gray-400">Search reservations, guests, rooms...</span>
          <kbd className="text-[10px] border border-gray-200 rounded px-1 py-0.5 bg-white text-gray-400 leading-none">⌘K</kbd>
        </div>
      </div>

      {/* Right: stats + bell + avatar */}
      <div className="flex items-center gap-3 shrink-0">
        {/* Occupancy */}
        <div className="flex flex-col items-end leading-none">
          <span className="text-[10px] text-gray-400">Occupancy</span>
          <span className="text-[12px] font-bold text-blue-600">{stats.occupancy}%</span>
        </div>
        {/* RevPAR */}
        <div className="flex flex-col items-end leading-none">
          <span className="text-[10px] text-gray-400">RevPAR</span>
          <span className="text-[12px] font-bold text-blue-600">${stats.revpar}</span>
        </div>

        <div className="h-5 w-px bg-gray-200" />

        {/* Notification bell */}
        <button className="relative w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-50 rounded-md transition-colors">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-blue-600 rounded-full text-[8px] text-white flex items-center justify-center font-bold">
            3
          </span>
        </button>

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
