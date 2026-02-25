'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  GlobeAltIcon,
  PhoneIcon,
  ChatBubbleLeftIcon,
  EnvelopeIcon,
  MapPinIcon,
} from '@heroicons/react/24/outline'
import { bookingSettingsService, type PropertySettings } from '@/services/booking'
import { CURRENCY_OPTIONS } from '@/lib/constants/booking'

type Tab = 'property' | 'notifications'

const LANGUAGE_OPTIONS = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'German' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'pl', label: 'Polish' },
  { code: 'cs', label: 'Czech' },
  { code: 'ro', label: 'Romanian' },
  { code: 'hr', label: 'Croatian' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ru', label: 'Russian' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ar', label: 'Arabic' },
]

const DEFAULT_SETTINGS: PropertySettings = {
  slug: '',
  property_name: '',
  reservation_email: '',
  phone_number: '',
  whatsapp_number: '',
  address: '',
  default_currency: 'EUR',
  supported_currencies: [],
  supported_languages: ['en'],
  email_notifications: true,
  new_booking_alerts: true,
  payment_alerts: true,
  weekly_reports: false,
}

export default function HotelSettingsSection({ hotelId }: { hotelId: string }) {
  const [activeTab, setActiveTab] = useState<Tab>('property')
  const [settings, setSettings] = useState<PropertySettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [showLanguageDropdown, setShowLanguageDropdown] = useState(false)
  const [showCurrencyDropdown, setShowCurrencyDropdown] = useState(false)

  const fetchSettings = useCallback(async () => {
    try {
      setLoading(true)
      const data = await bookingSettingsService.getPropertySettings(hotelId)
      setSettings(data)
    } catch {
      setFeedback({ type: 'error', message: 'Failed to load settings' })
    } finally {
      setLoading(false)
    }
  }, [hotelId])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  const handleSave = async () => {
    try {
      setSaving(true)
      setFeedback(null)
      const data = await bookingSettingsService.updatePropertySettings(hotelId, settings)
      setSettings(data)
      setFeedback({ type: 'success', message: 'Settings saved successfully' })
    } catch {
      setFeedback({ type: 'error', message: 'Failed to save settings' })
    } finally {
      setSaving(false)
    }
  }

  const addLanguage = (code: string) => {
    if (!settings.supported_languages.includes(code)) {
      setSettings({
        ...settings,
        supported_languages: [...settings.supported_languages, code],
      })
    }
    setShowLanguageDropdown(false)
  }

  const removeLanguage = (code: string) => {
    setSettings({
      ...settings,
      supported_languages: settings.supported_languages.filter((l) => l !== code),
    })
  }

  const addCurrency = (code: string) => {
    if (!settings.supported_currencies.includes(code)) {
      setSettings({
        ...settings,
        supported_currencies: [...settings.supported_currencies, code],
      })
    }
    setShowCurrencyDropdown(false)
  }

  const removeCurrency = (code: string) => {
    setSettings({
      ...settings,
      supported_currencies: settings.supported_currencies.filter((c) => c !== code),
    })
  }

  const tabs = [
    { id: 'property' as const, label: 'Property', icon: PropertyIcon },
    { id: 'notifications' as const, label: 'Notifications', icon: NotificationsIcon },
  ]

  return (
    <div className="max-w-3xl">
      {/* Tab bar */}
      <div className="bg-gray-100 rounded-lg p-1 grid grid-cols-2 max-w-xs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center justify-center gap-1.5 py-2 rounded-md text-[13px] transition-all ${
              activeTab === tab.id
                ? 'bg-white text-gray-900 font-semibold shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Feedback banner */}
      {feedback && (
        <div
          className={`mt-3 px-3 py-2.5 rounded-lg text-[13px] ${
            feedback.type === 'success'
              ? 'bg-green-50 text-green-800 border border-green-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}
        >
          {feedback.message}
        </div>
      )}

      {/* Property tab */}
      {activeTab === 'property' && (
        <div className="mt-5 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <div className="w-5 h-5 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {/* Property Information card */}
              <div className="bg-white rounded-lg border border-gray-200 p-5">
                <h2 className="text-sm font-semibold text-gray-900">Property Information</h2>
                <p className="text-[13px] text-gray-500 mt-0.5 mb-3">Basic details about the property</p>
                <div className="space-y-3">
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      Property Name
                    </label>
                    <input
                      type="text"
                      value={settings.property_name}
                      onChange={(e) => setSettings({ ...settings, property_name: e.target.value })}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      placeholder="Enter property name"
                    />
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      Address
                    </label>
                    <div className="relative">
                      <MapPinIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                      <input
                        type="text"
                        value={settings.address}
                        onChange={(e) => setSettings({ ...settings, address: e.target.value })}
                        className="w-full pl-8 pr-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        placeholder="Sekotong, Lombok Barat, NTB 83365, Indonesia"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Contact Information card */}
              <div className="bg-white rounded-lg border border-gray-200 p-5">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <PhoneIcon className="w-4 h-4 text-gray-700" />
                  <h2 className="text-sm font-semibold text-gray-900">Contact Information</h2>
                </div>
                <p className="text-[13px] text-gray-500 mb-3">How guests can reach the property</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      Phone Number
                    </label>
                    <div className="relative">
                      <PhoneIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                      <input
                        type="tel"
                        value={settings.phone_number}
                        onChange={(e) => setSettings({ ...settings, phone_number: e.target.value })}
                        className="w-full pl-8 pr-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        placeholder="+62 370 123 4567"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      WhatsApp
                    </label>
                    <div className="relative">
                      <ChatBubbleLeftIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                      <input
                        type="tel"
                        value={settings.whatsapp_number}
                        onChange={(e) => setSettings({ ...settings, whatsapp_number: e.target.value })}
                        className="w-full pl-8 pr-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        placeholder="+62 812 3456 7890"
                      />
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      Reservation Email
                    </label>
                    <div className="relative">
                      <EnvelopeIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                      <input
                        type="email"
                        value={settings.reservation_email}
                        onChange={(e) => setSettings({ ...settings, reservation_email: e.target.value })}
                        className="w-full pl-8 pr-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        placeholder="reservations@hotel.com"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Localization card */}
              <div className="bg-white rounded-lg border border-gray-200 p-5">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <GlobeAltIcon className="w-4 h-4 text-gray-700" />
                  <h2 className="text-sm font-semibold text-gray-900">Localization</h2>
                </div>
                <p className="text-[13px] text-gray-500 mb-3">Currency and language preferences</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      Default Currency
                    </label>
                    <select
                      value={settings.default_currency}
                      onChange={(e) => {
                        const newPrimary = e.target.value
                        setSettings({
                          ...settings,
                          default_currency: newPrimary,
                          supported_currencies: settings.supported_currencies.filter((c) => c !== newPrimary),
                        })
                      }}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white"
                    >
                      {CURRENCY_OPTIONS.map((c) => (
                        <option key={c.code} value={c.code}>{c.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      Supported Currencies
                    </label>
                    <div className="flex flex-wrap gap-1.5 items-center">
                      {settings.supported_currencies.map((code) => {
                        const cur = CURRENCY_OPTIONS.find((c) => c.code === code)
                        return (
                          <span
                            key={code}
                            className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary-50 text-primary-700 text-[13px] rounded-full"
                          >
                            {cur?.label || code}
                            <button
                              onClick={() => removeCurrency(code)}
                              className="ml-0.5 text-primary-400 hover:text-primary-600"
                            >
                              &times;
                            </button>
                          </span>
                        )
                      })}
                      <div className="relative">
                        <button
                          onClick={() => setShowCurrencyDropdown(!showCurrencyDropdown)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 border border-dashed border-gray-300 text-gray-500 text-[13px] rounded-full hover:border-gray-400 hover:text-gray-700"
                        >
                          + Add
                        </button>
                        {showCurrencyDropdown && (
                          <div className="absolute top-full left-0 mt-1 w-52 bg-white border border-gray-200 rounded-lg shadow-lg z-10 max-h-44 overflow-y-auto">
                            {CURRENCY_OPTIONS.filter(
                              (c) => c.code !== settings.default_currency && !settings.supported_currencies.includes(c.code)
                            ).map((cur) => (
                              <button
                                key={cur.code}
                                onClick={() => addCurrency(cur.code)}
                                className="block w-full text-left px-2.5 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50"
                              >
                                {cur.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      Supported Languages
                    </label>
                    <div className="flex flex-wrap gap-1.5 items-center">
                      {settings.supported_languages.map((code) => {
                        const lang = LANGUAGE_OPTIONS.find((l) => l.code === code)
                        return (
                          <span
                            key={code}
                            className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary-50 text-primary-700 text-[13px] rounded-full"
                          >
                            {lang?.label || code}
                            <button
                              onClick={() => removeLanguage(code)}
                              className="ml-0.5 text-primary-400 hover:text-primary-600"
                            >
                              &times;
                            </button>
                          </span>
                        )
                      })}
                      <div className="relative">
                        <button
                          onClick={() => setShowLanguageDropdown(!showLanguageDropdown)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 border border-dashed border-gray-300 text-gray-500 text-[13px] rounded-full hover:border-gray-400 hover:text-gray-700"
                        >
                          + Add
                        </button>
                        {showLanguageDropdown && (
                          <div className="absolute top-full left-0 mt-1 w-44 bg-white border border-gray-200 rounded-lg shadow-lg z-10 max-h-44 overflow-y-auto">
                            {LANGUAGE_OPTIONS.filter(
                              (l) => !settings.supported_languages.includes(l.code)
                            ).map((lang) => (
                              <button
                                key={lang.code}
                                onClick={() => addLanguage(lang.code)}
                                className="block w-full text-left px-2.5 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50"
                              >
                                {lang.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Save button */}
              <div className="flex justify-end">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary-500 text-white text-[13px] font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors"
                >
                  {saving ? (
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                    </svg>
                  )}
                  Save Changes
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Notifications tab */}
      {activeTab === 'notifications' && (
        <div className="mt-5 space-y-4">
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <div className="flex items-center gap-1.5 mb-0.5">
              <EnvelopeIcon className="w-4 h-4 text-gray-700" />
              <h2 className="text-sm font-semibold text-gray-900">Email Notifications</h2>
            </div>
            <p className="text-[13px] text-gray-500 mb-4">Configure when and how the hotel receives updates</p>

            {/* Email Notifications toggle */}
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="text-[13px] font-semibold text-gray-900">Email Notifications</p>
                <p className="text-[13px] text-gray-500">Receive notifications via email</p>
              </div>
              <button
                onClick={() => setSettings({ ...settings, email_notifications: !settings.email_notifications })}
                className={`relative w-10 h-[22px] rounded-full transition-colors ${
                  settings.email_notifications ? 'bg-primary-500' : 'bg-gray-300'
                }`}
              >
                <span className={`absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow transition-transform ${
                  settings.email_notifications ? 'translate-x-[18px]' : ''
                }`} />
              </button>
            </div>

            <div className="border-t border-gray-200 my-2" />

            {/* New Booking Alerts */}
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="text-[13px] font-semibold text-gray-900">New Booking Alerts</p>
                <p className="text-[13px] text-gray-500">Get notified when a new booking is made</p>
              </div>
              <button
                onClick={() => setSettings({ ...settings, new_booking_alerts: !settings.new_booking_alerts })}
                className={`relative w-10 h-[22px] rounded-full transition-colors ${
                  settings.new_booking_alerts ? 'bg-primary-500' : 'bg-gray-300'
                }`}
              >
                <span className={`absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow transition-transform ${
                  settings.new_booking_alerts ? 'translate-x-[18px]' : ''
                }`} />
              </button>
            </div>

            {/* Payment Alerts */}
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="text-[13px] font-semibold text-gray-900">Payment Alerts</p>
                <p className="text-[13px] text-gray-500">Get notified about payment events</p>
              </div>
              <button
                onClick={() => setSettings({ ...settings, payment_alerts: !settings.payment_alerts })}
                className={`relative w-10 h-[22px] rounded-full transition-colors ${
                  settings.payment_alerts ? 'bg-primary-500' : 'bg-gray-300'
                }`}
              >
                <span className={`absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow transition-transform ${
                  settings.payment_alerts ? 'translate-x-[18px]' : ''
                }`} />
              </button>
            </div>

            {/* Weekly Reports */}
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="text-[13px] font-semibold text-gray-900">Weekly Reports</p>
                <p className="text-[13px] text-gray-500">Receive weekly performance summaries</p>
              </div>
              <button
                onClick={() => setSettings({ ...settings, weekly_reports: !settings.weekly_reports })}
                className={`relative w-10 h-[22px] rounded-full transition-colors ${
                  settings.weekly_reports ? 'bg-primary-500' : 'bg-gray-300'
                }`}
              >
                <span className={`absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow transition-transform ${
                  settings.weekly_reports ? 'translate-x-[18px]' : ''
                }`} />
              </button>
            </div>
          </div>

          {/* Save button */}
          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary-500 text-white text-[13px] font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors"
            >
              {saving ? (
                <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                </svg>
              )}
              Save Changes
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function PropertyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
      <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
      <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
      <path d="M10 6h4" />
      <path d="M10 10h4" />
      <path d="M10 14h4" />
      <path d="M10 18h4" />
    </svg>
  )
}

function NotificationsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}
