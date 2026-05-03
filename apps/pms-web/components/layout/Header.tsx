'use client'

import { useState, useRef, useEffect } from 'react'
import { ChevronDownIcon, PlusIcon } from '@heroicons/react/24/outline'
import { useRouter } from 'next/navigation'
import { authService } from '@/services/auth'
import { bookingsService } from '@/services/bookings'
import { pmsSettingsService, HotelSummary } from '@/services/settings'
import { useTranslation, SUPPORTED_LANGUAGES } from '@/lib/i18n'

const BOOKING_ADMIN_URL = process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || 'https://admin.booking.vayada.com'

function buildHandoffUrl(baseUrl: string, path: string = ''): string {
  const token = typeof window !== 'undefined' ? localStorage.getItem('access_token') : null
  const expiresAt = typeof window !== 'undefined' ? localStorage.getItem('token_expires_at') : null
  const user = typeof window !== 'undefined' ? localStorage.getItem('user') : null
  if (!token || !expiresAt) return `${baseUrl}${path}`
  const params = new URLSearchParams({
    token,
    expires_at: expiresAt,
    ...(user ? { user: encodeURIComponent(user) } : {}),
  })
  return `${baseUrl}/handoff${path ? `?redirect=${encodeURIComponent(path)}` : ''}#${params.toString()}`
}

interface DayStats {
  arrivals: number
  departures: number
}

export default function Header({ onMenuToggle }: { onMenuToggle?: () => void }) {
  const router = useRouter()
  const { t, locale, setLocale } = useTranslation()
  const [profileOpen, setProfileOpen] = useState(false)
  const [propertyOpen, setPropertyOpen] = useState(false)
  const [langOpen, setLangOpen] = useState(false)
  const [hotels, setHotels] = useState<HotelSummary[]>([])
  const [selectedHotel, setSelectedHotel] = useState<HotelSummary | null>(null)

  const [userName, setUserName] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [stats, setStats] = useState<DayStats>({ arrivals: 0, departures: 0 })
  const profileRef = useRef<HTMLDivElement>(null)
  const propertyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false)
      }
      if (propertyRef.current && !propertyRef.current.contains(e.target as Node)) {
        setPropertyOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    setUserName(localStorage.getItem('userName') || '')
    setUserEmail(localStorage.getItem('userEmail') || '')

    pmsSettingsService.listHotels().then((list) => {
      setHotels(list)
      if (list.length > 0) {
        const savedId = localStorage.getItem('selectedHotelId')
        const saved = list.find((h) => h.id === savedId)
        const selected = saved || list[0]
        setSelectedHotel(selected)
        localStorage.setItem('selectedHotelId', selected.id)
      }
    }).catch(() => {})
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
      {/* Mobile menu button */}
      <button onClick={onMenuToggle} className="lg:hidden p-1 -ml-1 text-gray-600 hover:text-gray-900">
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
      </button>
      {/* Left: property switcher + date */}
      <div className="flex items-center gap-4 shrink-0">
        {/* Property Selector — always shown so single-hotel users can
            still reach the "Add Property" action that lives inside it. */}
        <div className="relative" ref={propertyRef}>
          <button
            onClick={() => setPropertyOpen(!propertyOpen)}
            className="flex items-center gap-1 text-[13px] text-gray-700 hover:text-gray-900 transition-colors"
          >
            <span className="font-medium">{selectedHotel?.name || t('layout.header.noProperties')}</span>
            <ChevronDownIcon className={`w-3.5 h-3.5 text-gray-400 transition-transform ${propertyOpen ? 'rotate-180' : ''}`} />
          </button>

          {propertyOpen && (
            <div className="absolute top-full left-0 mt-1.5 w-60 bg-white border border-gray-200 rounded-lg shadow-lg py-1.5 z-50">
              <p className="px-3 py-1.5 text-xs text-gray-500">{t('layout.header.switchProperty')}</p>
              <div className="px-1.5 max-h-60 overflow-y-auto">
                {hotels.map((hotel) => {
                  const isSelected = selectedHotel?.id === hotel.id
                  return (
                    <button
                      key={hotel.id}
                      onClick={() => {
                        if (!isSelected) {
                          localStorage.setItem('selectedHotelId', hotel.id)
                          window.location.reload()
                        }
                        setPropertyOpen(false)
                      }}
                      className={`w-full text-left px-2.5 py-2 rounded-md transition-colors ${
                        isSelected
                          ? 'bg-primary-500 text-white'
                          : 'hover:bg-gray-50'
                      }`}
                    >
                      <p className={`text-[13px] font-semibold ${isSelected ? 'text-white' : 'text-gray-900'}`}>
                        {hotel.name}
                      </p>
                      <p className={`text-[11px] ${isSelected ? 'text-primary-100' : 'text-gray-500'}`}>
                        {hotel.location}
                      </p>
                    </button>
                  )
                })}
              </div>
              {/* Add Property — ?mode=add tells the booking-admin setup
                  page to skip the "setup_complete → /dashboard" guard,
                  which would otherwise instantly redirect a user who
                  already has one hotel back to the dashboard. */}
              <div className="border-t border-gray-100 mt-1 pt-1 px-1.5">
                <button
                  onClick={() => {
                    setPropertyOpen(false)
                    window.location.href = buildHandoffUrl(BOOKING_ADMIN_URL, '/setup?mode=add')
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-[13px] text-primary-600 hover:bg-primary-50 transition-colors"
                >
                  <PlusIcon className="w-4 h-4" />
                  {t('layout.header.addProperty')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Separator */}
        <div className="w-px h-5 bg-gray-200 hidden md:block" />

        {/* Date + stats */}
        <div className="hidden md:flex flex-col justify-center">
          <p className="text-[12px] font-semibold text-gray-900 leading-tight">{dateStr}</p>
          <p className="text-[10px] text-gray-400 leading-tight">
            {stats.arrivals} {t('layout.header.arrivals')} · {stats.departures} {t('layout.header.departures')}
          </p>
        </div>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right: avatar */}
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
                <p className="text-[13px] font-semibold text-gray-900 truncate" title={userName || undefined}>{userName || t('layout.header.user')}</p>
                <p className="text-xs text-gray-500 truncate" title={userEmail || undefined}>{userEmail}</p>
              </div>
              <div className="border-t border-gray-100" />
              <div className="py-1">
                <button
                  onClick={() => { setProfileOpen(false); router.push('/settings') }}
                  className="w-full text-left px-3.5 py-2 text-[13px] text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  {t('layout.sidebar.settings')}
                </button>
                {/* Language selector */}
                <div className="relative">
                  <button
                    onClick={(e) => { e.stopPropagation(); setLangOpen(!langOpen) }}
                    className="w-full flex items-center justify-between px-3.5 py-2 text-[13px] text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    <span>{t('layout.header.language')}</span>
                    <span className="text-gray-400">{SUPPORTED_LANGUAGES.find(l => l.code === locale)?.flag} {SUPPORTED_LANGUAGES.find(l => l.code === locale)?.nativeName}</span>
                  </button>
                  {langOpen && (
                    <div className="absolute right-full top-0 mr-1 w-48 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50 max-h-72 overflow-y-auto">
                      {SUPPORTED_LANGUAGES.map((lang) => (
                        <button
                          key={lang.code}
                          onClick={() => { setLocale(lang.code); setLangOpen(false); setProfileOpen(false) }}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-left transition-colors ${
                            locale === lang.code ? 'bg-primary-50 text-primary-700 font-medium' : 'text-gray-700 hover:bg-gray-50'
                          }`}
                        >
                          <span>{lang.flag}</span>
                          <span>{lang.nativeName}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="border-t border-gray-100" />
              <div className="py-1">
                <button
                  onClick={() => authService.logout()}
                  className="w-full text-left px-3.5 py-2 text-[13px] text-red-500 hover:bg-red-50 transition-colors"
                >
                  {t('layout.header.signOut')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
