'use client'

import { useState, useRef, useEffect } from 'react'
import {
  MagnifyingGlassIcon,
  BellIcon,
  ChevronDownIcon,
  ArrowTopRightOnSquareIcon,
  CalendarDaysIcon,
  CreditCardIcon,
  UserPlusIcon,
} from '@heroicons/react/24/outline'
import { authService } from '@/services/auth'
import { settingsService, HotelSummary } from '@/services/settings'

const notifications = [
  {
    id: '1',
    icon: CalendarDaysIcon,
    title: 'New booking received',
    description: 'John Smith booked Ocean View Suite for Jan 15-18',
    time: '5 min ago',
    unread: true,
  },
  {
    id: '2',
    icon: CreditCardIcon,
    title: 'Payment confirmed',
    description: '$1,250 received for booking #4521',
    time: '1 hour ago',
    unread: true,
  },
  {
    id: '3',
    icon: UserPlusIcon,
    title: 'New affiliate signup',
    description: 'Travel Blogger Jane joined your program',
    time: '3 hours ago',
    unread: true,
  },
]

export default function Header() {
  const [searchQuery, setSearchQuery] = useState('')
  const [hotels, setHotels] = useState<HotelSummary[]>([])
  const [selectedHotel, setSelectedHotel] = useState<HotelSummary | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [userName, setUserName] = useState('')
  const [userEmail, setUserEmail] = useState('')
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
    settingsService.listHotels().then((list) => {
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

  return (
    <header className="h-12 bg-white border-b border-gray-200 flex items-center justify-between px-4 shrink-0">
      {/* Left section: Property Selector + Search */}
      <div className="flex items-center gap-4">
        {/* Property Selector Dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-1 text-[13px] text-gray-700 hover:text-gray-900 transition-colors"
          >
            <span className="font-medium">{selectedHotel?.name || 'No properties'}</span>
            <ChevronDownIcon className={`w-3.5 h-3.5 text-gray-400 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
          </button>

          {dropdownOpen && hotels.length > 0 && (
            <div className="absolute top-full left-0 mt-1.5 w-60 bg-white border border-gray-200 rounded-lg shadow-lg py-1.5 z-50">
              <p className="px-3 py-1.5 text-xs text-gray-500">Switch Property</p>
              <div className="px-1.5">
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
            </div>
          )}
        </div>

        {/* Search Bar */}
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
          <input
            type="text"
            placeholder="Search settings..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-56 pl-8 pr-3 py-1.5 text-[13px] bg-gray-50 border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent placeholder-gray-400 transition-all"
          />
        </div>
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
          Preview
        </button>

        {/* Notification Bell + Dropdown */}
        <div className="relative" ref={notificationsRef}>
          <button
            onClick={() => setNotificationsOpen(!notificationsOpen)}
            className="relative p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-50 rounded-md transition-colors"
          >
            <BellIcon className="w-4 h-4" />
            <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] bg-primary-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
              3
            </span>
          </button>

          {notificationsOpen && (
            <div className="absolute top-full right-0 mt-1.5 w-80 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3">
                <h3 className="text-[13px] font-semibold text-gray-900">Notifications</h3>
                <button className="text-xs text-gray-500 hover:text-gray-700 transition-colors">
                  Mark all read
                </button>
              </div>

              {/* Notification items */}
              <div className="divide-y divide-gray-100">
                {notifications.map((notification) => (
                  <div key={notification.id} className="flex items-start gap-2.5 px-4 py-3 hover:bg-gray-50 transition-colors cursor-pointer">
                    <div className="w-8 h-8 rounded-full bg-primary-50 flex items-center justify-center shrink-0">
                      <notification.icon className="w-4 h-4 text-primary-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-semibold text-gray-900">{notification.title}</p>
                      <p className="text-xs text-gray-600 mt-0.5">{notification.description}</p>
                      <p className="text-[11px] text-gray-400 mt-0.5">{notification.time}</p>
                    </div>
                    {notification.unread && (
                      <div className="w-2 h-2 rounded-full bg-primary-500 shrink-0 mt-1.5" />
                    )}
                  </div>
                ))}
              </div>

              {/* Footer */}
              <div className="border-t border-gray-100">
                <button className="w-full py-2.5 text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-50 transition-colors rounded-b-lg">
                  View all notifications
                </button>
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
                <p className="text-[13px] font-semibold text-gray-900">{userName || 'User'}</p>
                <p className="text-xs text-gray-500">{userEmail}</p>
              </div>
              <div className="border-t border-gray-100" />
              {/* Menu items */}
              <div className="py-1">
                <button className="w-full text-left px-3.5 py-2 text-[13px] text-gray-700 hover:bg-gray-50 transition-colors">
                  Account Settings
                </button>
              </div>
              <div className="border-t border-gray-100" />
              {/* Sign out */}
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
