'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  BellIcon,
  ChevronDownIcon,
  ArrowTopRightOnSquareIcon,
  PlusIcon,
} from '@heroicons/react/24/outline'
import { authService } from '@/services/auth'
import { settingsService, HotelSummary, SuperAdminHotel } from '@/services/settings'
import { useTranslation, SUPPORTED_LANGUAGES } from '@/lib/i18n'

export default function Header({ onMenuToggle }: { onMenuToggle?: () => void }) {
  const router = useRouter()
  const { t, locale, setLocale } = useTranslation()
  const [hotels, setHotels] = useState<(HotelSummary | SuperAdminHotel)[]>([])
  const [selectedHotel, setSelectedHotel] = useState<(HotelSummary | SuperAdminHotel) | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [langOpen, setLangOpen] = useState(false)
  const [userName, setUserName] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [isSuperAdmin, setIsSuperAdmin] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const notificationsRef = useRef<HTMLDivElement>(null)
  const profileRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
      if (notificationsRef.current && !notificationsRef.current.contains(e.target as Node)) {
        setNotificationsOpen(false)
      }
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
    const superAdmin = authService.isSuperAdmin()
    setIsSuperAdmin(superAdmin)

    const fetchHotels = superAdmin
      ? settingsService.listAllHotels()
      : settingsService.listHotels()

    fetchHotels.then((list) => {
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

  const initials = userName
    ? userName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    : '?'

  // Check if the selected hotel is owned by another user (super admin managing someone else's hotel)
  const isManagingOtherHotel = isSuperAdmin && selectedHotel && 'owner_email' in selectedHotel

  return (
    <header className="h-12 bg-white border-b border-gray-200 flex items-center justify-between px-4 shrink-0">
      {/* Left section: Hamburger + Property Selector + Super Admin Badge */}
      <div className="flex items-center gap-2 md:gap-4">
        {/* Mobile hamburger */}
        <button
          onClick={onMenuToggle}
          className="lg:hidden p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-50 rounded-md transition-colors"
          aria-label="Toggle menu"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </button>
        {/* Property Selector Dropdown */}
        <div className="relative" ref={dropdownRef}>
          {hotels.length <= 1 && !isSuperAdmin ? (
            <span className="text-[13px] font-medium text-gray-700">
              {selectedHotel?.name || t('layout.header.noProperties')}
            </span>
          ) : (
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="flex items-center gap-1 text-[13px] text-gray-700 hover:text-gray-900 transition-colors"
            >
              <span className="font-medium">{selectedHotel?.name || t('layout.header.noProperties')}</span>
              <ChevronDownIcon className={`w-3.5 h-3.5 text-gray-400 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
            </button>
          )}

          {dropdownOpen && (
            <div className="absolute top-full left-0 mt-1.5 w-60 bg-white border border-gray-200 rounded-lg shadow-lg py-1.5 z-50">
              <p className="px-3 py-1.5 text-xs text-gray-500">{t('layout.header.switchProperty')}</p>
              {isSuperAdmin && (
                <button
                  onClick={() => {
                    setDropdownOpen(false)
                    router.push('/manage-hotels')
                  }}
                  className="w-full text-left px-3 py-2 text-xs text-primary-600 hover:bg-primary-50 transition-colors border-b border-gray-100 mb-1"
                >
                  {t('layout.header.viewAllHotels')}
                </button>
              )}
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
                        setDropdownOpen(false)
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
              {/* Add Property */}
              <div className="border-t border-gray-100 mt-1 pt-1 px-1.5">
                <button
                  onClick={() => {
                    setDropdownOpen(false)
                    router.push('/setup')
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

        {/* Super Admin Badge */}
        {isManagingOtherHotel && (
          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-700 rounded-full">
            {t('layout.header.superAdmin')}
          </span>
        )}

      </div>

      {/* Right section: Preview + Notifications + Profile */}
      <div className="flex items-center gap-2">
        {/* Preview Button */}
        <button
          onClick={() => {
            if (selectedHotel?.slug) {
              window.open(`https://${selectedHotel.slug}.booking.vayada.com`, '_blank')
            }
          }}
          disabled={!selectedHotel?.slug}
          className="flex items-center gap-1 px-2.5 py-1 text-[13px] font-medium text-primary-600 bg-primary-50 border border-primary-200 rounded-md hover:bg-primary-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
          <span className="hidden md:inline">{t('layout.header.preview')}</span>
        </button>

        {/* Notification Bell + Dropdown */}
        <div className="relative" ref={notificationsRef}>
          <button
            onClick={() => setNotificationsOpen(!notificationsOpen)}
            className="relative p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-50 rounded-md transition-colors"
          >
            <BellIcon className="w-4 h-4" />
          </button>

          {notificationsOpen && (
            <div className="absolute top-full right-0 mt-1.5 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
              <div className="px-4 py-3">
                <h3 className="text-[13px] font-semibold text-gray-900">{t('layout.header.notifications')}</h3>
              </div>
              <div className="px-4 py-6 text-center">
                <BellIcon className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                <p className="text-[13px] text-gray-500">{t('layout.header.noNotifications')}</p>
              </div>
            </div>
          )}
        </div>

        {/* Profile Avatar + Dropdown */}
        <div className="relative" ref={profileRef}>
          <button
            onClick={() => setProfileOpen(!profileOpen)}
            className="w-7 h-7 bg-primary-600 rounded-full flex items-center justify-center text-white text-[10px] font-semibold hover:bg-primary-700 transition-colors"
          >
            {initials}
          </button>

          {profileOpen && (
            <div className="absolute top-full right-0 mt-1.5 w-52 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1">
              {/* User info */}
              <div className="px-3.5 py-2.5">
                <p className="text-[13px] font-semibold text-gray-900">{userName || t('layout.header.user')}</p>
                <p className="text-xs text-gray-500">{userEmail}</p>
                {isSuperAdmin && (
                  <span className="inline-flex items-center mt-1 px-1.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-700 rounded">
                    {t('layout.header.superAdmin')}
                  </span>
                )}
              </div>
              <div className="border-t border-gray-100" />
              {/* Menu items */}
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
              {/* Sign out */}
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
