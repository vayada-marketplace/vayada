'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  BellIcon,
  ShieldCheckIcon,
  DocumentTextIcon,
  GlobeAltIcon,
  PhoneIcon,
  ChatBubbleLeftIcon,
  EnvelopeIcon,
  MapPinIcon,
  LockClosedIcon,
  EyeIcon,
  EyeSlashIcon,
} from '@heroicons/react/24/outline'
import { settingsService, type PropertySettings } from '@/services/settings'
import { CURRENCY_OPTIONS } from '@/lib/constants/options'

type Tab = 'property' | 'notifications' | 'security' | 'billing'

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

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('property')
  const [settings, setSettings] = useState<PropertySettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [showLanguageDropdown, setShowLanguageDropdown] = useState(false)
  const [showCurrencyDropdown, setShowCurrencyDropdown] = useState(false)

  // Email form state
  const [emailForm, setEmailForm] = useState({ new_email: '', password: '' })
  const [changingEmail, setChangingEmail] = useState(false)
  const [emailFeedback, setEmailFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [showEmailPassword, setShowEmailPassword] = useState(false)

  // Password form state
  const [passwordForm, setPasswordForm] = useState({ current_password: '', new_password: '', confirm_password: '' })
  const [changingPassword, setChangingPassword] = useState(false)
  const [passwordFeedback, setPasswordFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [showCurrentPassword, setShowCurrentPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  const handleChangeEmail = async () => {
    try {
      setChangingEmail(true)
      setEmailFeedback(null)
      await settingsService.changeEmail(emailForm.new_email, emailForm.password)
      setEmailFeedback({ type: 'success', message: 'Email updated successfully' })
      setEmailForm({ new_email: '', password: '' })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to update email'
      setEmailFeedback({ type: 'error', message })
    } finally {
      setChangingEmail(false)
    }
  }

  const handleChangePassword = async () => {
    if (passwordForm.new_password !== passwordForm.confirm_password) {
      setPasswordFeedback({ type: 'error', message: 'New passwords do not match' })
      return
    }
    if (passwordForm.new_password.length < 8) {
      setPasswordFeedback({ type: 'error', message: 'Password must be at least 8 characters' })
      return
    }
    try {
      setChangingPassword(true)
      setPasswordFeedback(null)
      await settingsService.changePassword(passwordForm.current_password, passwordForm.new_password)
      setPasswordFeedback({ type: 'success', message: 'Password updated successfully' })
      setPasswordForm({ current_password: '', new_password: '', confirm_password: '' })
    } catch {
      setPasswordFeedback({ type: 'error', message: 'Failed to update password. Check your current password.' })
    } finally {
      setChangingPassword(false)
    }
  }

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
    { id: 'security' as const, label: 'Security', icon: SecurityIcon },
    { id: 'billing' as const, label: 'Billing', icon: BillingIcon },
  ]

  return (
    <div className="p-6 max-w-3xl">
          <h1 className="text-xl font-bold text-gray-900">Settings</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage your property and account preferences</p>

          {/* Tab bar */}
          <div className="mt-5 bg-gray-100 rounded-lg p-1 grid grid-cols-4">
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
                    <p className="text-[13px] text-gray-500 mt-0.5 mb-3">Basic details about your property</p>
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
                    <p className="text-[13px] text-gray-500 mb-3">How guests can reach you — shown on your booking site</p>
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
                <p className="text-[13px] text-gray-500 mb-4">Configure when and how you receive updates</p>

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

          {/* Security tab */}
          {activeTab === 'security' && (
            <div className="mt-5 space-y-4">
              {/* Change Email card */}
              <div className="bg-white rounded-lg border border-gray-200 p-5">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <EnvelopeIcon className="w-4 h-4 text-gray-700" />
                  <h2 className="text-sm font-semibold text-gray-900">Change Email</h2>
                </div>
                <p className="text-[13px] text-gray-500 mb-4">Update your account email address</p>

                <div className="space-y-3 max-w-sm">
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      New Email
                    </label>
                    <div className="relative">
                      <EnvelopeIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                      <input
                        type="email"
                        value={emailForm.new_email}
                        onChange={(e) => setEmailForm({ ...emailForm, new_email: e.target.value })}
                        className="w-full pl-8 pr-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        placeholder="Enter new email address"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      Current Password
                    </label>
                    <div className="relative">
                      <input
                        type={showEmailPassword ? 'text' : 'password'}
                        value={emailForm.password}
                        onChange={(e) => setEmailForm({ ...emailForm, password: e.target.value })}
                        className="w-full px-2.5 py-1.5 pr-9 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        placeholder="Confirm with your password"
                      />
                      <button
                        type="button"
                        onClick={() => setShowEmailPassword(!showEmailPassword)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        {showEmailPassword ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                </div>

                {emailFeedback && (
                  <div
                    className={`mt-3 px-3 py-2.5 rounded-lg text-[13px] max-w-sm ${
                      emailFeedback.type === 'success'
                        ? 'bg-green-50 text-green-800 border border-green-200'
                        : 'bg-red-50 text-red-800 border border-red-200'
                    }`}
                  >
                    {emailFeedback.message}
                  </div>
                )}

                <div className="flex justify-end mt-4">
                  <button
                    onClick={handleChangeEmail}
                    disabled={changingEmail || !emailForm.new_email || !emailForm.password}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary-500 text-white text-[13px] font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors"
                  >
                    {changingEmail ? (
                      <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <EnvelopeIcon className="w-3.5 h-3.5" />
                    )}
                    Update Email
                  </button>
                </div>
              </div>

              {/* Change Password card */}
              <div className="bg-white rounded-lg border border-gray-200 p-5">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <LockClosedIcon className="w-4 h-4 text-gray-700" />
                  <h2 className="text-sm font-semibold text-gray-900">Change Password</h2>
                </div>
                <p className="text-[13px] text-gray-500 mb-4">Update your account password</p>

                <div className="space-y-3 max-w-sm">
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      Current Password
                    </label>
                    <div className="relative">
                      <input
                        type={showCurrentPassword ? 'text' : 'password'}
                        value={passwordForm.current_password}
                        onChange={(e) => setPasswordForm({ ...passwordForm, current_password: e.target.value })}
                        className="w-full px-2.5 py-1.5 pr-9 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        placeholder="Enter current password"
                      />
                      <button
                        type="button"
                        onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        {showCurrentPassword ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      New Password
                    </label>
                    <div className="relative">
                      <input
                        type={showNewPassword ? 'text' : 'password'}
                        value={passwordForm.new_password}
                        onChange={(e) => setPasswordForm({ ...passwordForm, new_password: e.target.value })}
                        className="w-full px-2.5 py-1.5 pr-9 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        placeholder="Enter new password"
                      />
                      <button
                        type="button"
                        onClick={() => setShowNewPassword(!showNewPassword)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        {showNewPassword ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      Confirm New Password
                    </label>
                    <div className="relative">
                      <input
                        type={showConfirmPassword ? 'text' : 'password'}
                        value={passwordForm.confirm_password}
                        onChange={(e) => setPasswordForm({ ...passwordForm, confirm_password: e.target.value })}
                        className="w-full px-2.5 py-1.5 pr-9 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        placeholder="Confirm new password"
                      />
                      <button
                        type="button"
                        onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        {showConfirmPassword ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                </div>

                {passwordFeedback && (
                  <div
                    className={`mt-3 px-3 py-2.5 rounded-lg text-[13px] max-w-sm ${
                      passwordFeedback.type === 'success'
                        ? 'bg-green-50 text-green-800 border border-green-200'
                        : 'bg-red-50 text-red-800 border border-red-200'
                    }`}
                  >
                    {passwordFeedback.message}
                  </div>
                )}

                <div className="flex justify-end mt-4">
                  <button
                    onClick={handleChangePassword}
                    disabled={changingPassword || !passwordForm.current_password || !passwordForm.new_password || !passwordForm.confirm_password}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary-500 text-white text-[13px] font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors"
                  >
                    {changingPassword ? (
                      <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <LockClosedIcon className="w-3.5 h-3.5" />
                    )}
                    Update Password
                  </button>
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

function SecurityIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

function BillingIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </svg>
  )
}
