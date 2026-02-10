'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  BuildingOfficeIcon,
  CreditCardIcon,
  DocumentTextIcon,
  BellIcon,
  ShieldCheckIcon,
  GlobeAltIcon,
} from '@heroicons/react/24/outline'
import { settingsService, type PropertySettings } from '@/services/settings'

type Tab = 'property' | 'notifications' | 'security' | 'billing'

const TIMEZONE_OPTIONS = [
  'UTC',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Rome',
  'Europe/Madrid',
  'Europe/Amsterdam',
  'Europe/Brussels',
  'Europe/Vienna',
  'Europe/Zurich',
  'Europe/Athens',
  'Europe/Istanbul',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Asia/Dubai',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Australia/Sydney',
]

const CURRENCY_OPTIONS = [
  'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK',
  'HUF', 'RON', 'BGN', 'HRK', 'TRY', 'RUB', 'JPY', 'CNY', 'AUD',
  'CAD', 'SGD', 'AED', 'THB', 'INR', 'BRL', 'MXN',
]

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
  property_name: '',
  reservation_email: '',
  phone_number: '',
  timezone: 'UTC',
  default_currency: 'EUR',
  supported_languages: ['en'],
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('property')
  const [settings, setSettings] = useState<PropertySettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [showLanguageDropdown, setShowLanguageDropdown] = useState(false)

  const fetchSettings = useCallback(async () => {
    try {
      setLoading(true)
      const data = await settingsService.getPropertySettings()
      setSettings(data)
    } catch {
      setFeedback({ type: 'error', message: 'Failed to load settings' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  const handleSave = async () => {
    try {
      setSaving(true)
      setFeedback(null)
      const data = await settingsService.updatePropertySettings(settings)
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

  const tabs = [
    { id: 'property' as const, label: 'Property', icon: BuildingOfficeIcon },
    { id: 'notifications' as const, label: 'Notifications', icon: BellIcon },
    { id: 'security' as const, label: 'Security', icon: ShieldCheckIcon },
    { id: 'billing' as const, label: 'Billing', icon: CreditCardIcon },
  ]

  return (
    <div className="p-6 max-w-3xl">
          <h1 className="text-xl font-bold text-gray-900">Settings</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage your property and account preferences</p>

          {/* Tab bar */}
          <div className="mt-5 border-b border-gray-200">
            <nav className="flex gap-5">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-1.5 pb-2.5 text-[13px] transition-colors border-b-2 ${
                    activeTab === tab.id
                      ? 'border-primary-500 text-gray-900 font-semibold'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <tab.icon className="w-3.5 h-3.5" />
                  {tab.label}
                </button>
              ))}
            </nav>
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
                    <p className="text-[13px] text-gray-500 mt-0.5 mb-3">Basic details about your property</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
                          Reservation Email
                        </label>
                        <input
                          type="email"
                          value={settings.reservation_email}
                          onChange={(e) => setSettings({ ...settings, reservation_email: e.target.value })}
                          className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                          placeholder="reservations@hotel.com"
                        />
                      </div>
                      <div>
                        <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                          Phone Number
                        </label>
                        <input
                          type="tel"
                          value={settings.phone_number}
                          onChange={(e) => setSettings({ ...settings, phone_number: e.target.value })}
                          className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                          placeholder="+1 234 567 890"
                        />
                      </div>
                      <div>
                        <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                          Timezone
                        </label>
                        <select
                          value={settings.timezone}
                          onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}
                          className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white"
                        >
                          {TIMEZONE_OPTIONS.map((tz) => (
                            <option key={tz} value={tz}>{tz}</option>
                          ))}
                        </select>
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
                          onChange={(e) => setSettings({ ...settings, default_currency: e.target.value })}
                          className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white"
                        >
                          {CURRENCY_OPTIONS.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
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
                  <div className="flex justify-center">
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
                <h2 className="text-sm font-semibold text-gray-900 mb-1">Notification Preferences</h2>
                <p className="text-[13px] text-gray-500">Configure how you receive notifications</p>
                <div className="mt-4 flex flex-col items-center justify-center py-6 text-gray-400">
                  <BellIcon className="w-8 h-8 mb-2" />
                  <p className="text-[13px]">Coming soon</p>
                </div>
              </div>
            </div>
          )}

          {/* Security tab */}
          {activeTab === 'security' && (
            <div className="mt-5 space-y-4">
              <div className="bg-white rounded-lg border border-gray-200 p-5">
                <h2 className="text-sm font-semibold text-gray-900 mb-1">Security Settings</h2>
                <p className="text-[13px] text-gray-500">Manage your account security</p>
                <div className="mt-4 flex flex-col items-center justify-center py-6 text-gray-400">
                  <ShieldCheckIcon className="w-8 h-8 mb-2" />
                  <p className="text-[13px]">Coming soon</p>
                </div>
              </div>
            </div>
          )}

          {/* Billing tab */}
          {activeTab === 'billing' && (
            <div className="mt-5 space-y-4">
              {/* Current Plan card */}
              <div className="bg-white rounded-lg border border-gray-200 p-5">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-gray-900">Current Plan</h2>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-100 text-green-800">
                    Active
                  </span>
                </div>
                <div className="space-y-1.5">
                  <p className="text-base font-semibold text-gray-900">Professional Plan</p>
                  <p className="text-[13px] text-gray-500">
                    <span className="text-xl font-bold text-gray-900">$99</span> /month
                  </p>
                  <p className="text-[13px] text-gray-500">
                    Next renewal: March 1, 2026
                  </p>
                </div>
                <button className="mt-3 px-3 py-1.5 border border-gray-300 text-[13px] font-medium text-gray-700 rounded-lg hover:bg-gray-50 transition-colors">
                  Manage Plan
                </button>
              </div>

              {/* Payment Method card */}
              <div className="bg-white rounded-lg border border-gray-200 p-5">
                <h2 className="text-sm font-semibold text-gray-900 mb-3">Payment Method</h2>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-6 bg-blue-600 rounded flex items-center justify-center">
                      <span className="text-white text-[9px] font-bold">VISA</span>
                    </div>
                    <div>
                      <p className="text-[13px] font-medium text-gray-900">Visa ending in 4242</p>
                      <p className="text-[11px] text-gray-500">Expires 12/27</p>
                    </div>
                  </div>
                  <button className="px-2.5 py-1 text-[13px] text-gray-600 hover:text-gray-800 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
                    Edit
                  </button>
                </div>
              </div>

              {/* Billing History card */}
              <div className="bg-white rounded-lg border border-gray-200 p-5">
                <h2 className="text-sm font-semibold text-gray-900 mb-3">Billing History</h2>
                <div className="flex flex-col items-center justify-center py-6 text-gray-400">
                  <DocumentTextIcon className="w-8 h-8 mb-1.5" />
                  <p className="text-[13px]">No invoices yet</p>
                </div>
              </div>
            </div>
          )}
    </div>
  )
}
