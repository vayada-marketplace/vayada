'use client'

import { useEffect, useState, useCallback } from 'react'
import { pmsClient } from '@/services/api/pmsClient'
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
} from '@heroicons/react/24/outline'
import { settingsService, type PropertySettings } from '@/services/settings'
import { CURRENCY_OPTIONS } from '@/lib/constants/options'
import { ToggleSwitch, FeedbackAlert, PasswordField, SaveButton } from '@/components/ui'

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
  check_in_time: '15:00',
  check_out_time: '11:00',
  pay_at_property_enabled: false,
  free_cancellation_days: 7,
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

  // Password form state
  const [passwordForm, setPasswordForm] = useState({ current_password: '', new_password: '', confirm_password: '' })
  const [changingPassword, setChangingPassword] = useState(false)
  const [passwordFeedback, setPasswordFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

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
      // Sync slug and name to PMS
      try {
        await pmsClient.patch('/admin/hotel', {
          slug: data.slug,
          name: data.property_name,
          contactEmail: data.reservation_email,
        })
      } catch {
        // Non-fatal: PMS sync may fail if not using Vayada PMS
      }
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

  const updateSetting = <K extends keyof PropertySettings>(key: K, value: PropertySettings[K]) => {
    setSettings({ ...settings, [key]: value })
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
            <FeedbackAlert type={feedback.type} message={feedback.message} className="mt-3" />
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
                          onChange={(e) => updateSetting('property_name', e.target.value)}
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
                            onChange={(e) => updateSetting('address', e.target.value)}
                            className="w-full pl-8 pr-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                            placeholder="Sekotong, Lombok Barat, NTB 83365, Indonesia"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                            Check-in Time
                          </label>
                          <input
                            type="time"
                            value={settings.check_in_time}
                            onChange={(e) => updateSetting('check_in_time', e.target.value)}
                            className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                          />
                        </div>
                        <div>
                          <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                            Check-out Time
                          </label>
                          <input
                            type="time"
                            value={settings.check_out_time}
                            onChange={(e) => updateSetting('check_out_time', e.target.value)}
                            className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
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
                            onChange={(e) => updateSetting('phone_number', e.target.value)}
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
                            onChange={(e) => updateSetting('whatsapp_number', e.target.value)}
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
                            onChange={(e) => updateSetting('reservation_email', e.target.value)}
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
                            <option key={c.code} value={c.code}>{c.flag} {c.name}</option>
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
                                {cur ? `${cur.flag} ${cur.code}` : code}
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
                                    {cur.flag} {cur.name}
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
                    <SaveButton onClick={handleSave} saving={saving} />
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

                <ToggleSwitch
                  enabled={settings.email_notifications}
                  onChange={() => updateSetting('email_notifications', !settings.email_notifications)}
                  label="Email Notifications"
                  description="Receive notifications via email"
                />

                <div className="border-t border-gray-200 my-2" />

                <ToggleSwitch
                  enabled={settings.new_booking_alerts}
                  onChange={() => updateSetting('new_booking_alerts', !settings.new_booking_alerts)}
                  label="New Booking Alerts"
                  description="Get notified when a new booking is made"
                />

                <ToggleSwitch
                  enabled={settings.payment_alerts}
                  onChange={() => updateSetting('payment_alerts', !settings.payment_alerts)}
                  label="Payment Alerts"
                  description="Get notified about payment events"
                />

                <ToggleSwitch
                  enabled={settings.weekly_reports}
                  onChange={() => updateSetting('weekly_reports', !settings.weekly_reports)}
                  label="Weekly Reports"
                  description="Receive weekly performance summaries"
                />
              </div>

              {/* Save button */}
              <div className="flex justify-end">
                <SaveButton onClick={handleSave} saving={saving} />
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
                  <PasswordField
                    label="Current Password"
                    value={emailForm.password}
                    onChange={(value) => setEmailForm({ ...emailForm, password: value })}
                    placeholder="Confirm with your password"
                  />
                </div>

                {emailFeedback && (
                  <FeedbackAlert type={emailFeedback.type} message={emailFeedback.message} className="mt-3 max-w-sm" />
                )}

                <div className="flex justify-end mt-4">
                  <SaveButton
                    onClick={handleChangeEmail}
                    saving={changingEmail}
                    disabled={!emailForm.new_email || !emailForm.password}
                    icon={<EnvelopeIcon className="w-3.5 h-3.5" />}
                  >
                    Update Email
                  </SaveButton>
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
                  <PasswordField
                    label="Current Password"
                    value={passwordForm.current_password}
                    onChange={(value) => setPasswordForm({ ...passwordForm, current_password: value })}
                    placeholder="Enter current password"
                  />
                  <PasswordField
                    label="New Password"
                    value={passwordForm.new_password}
                    onChange={(value) => setPasswordForm({ ...passwordForm, new_password: value })}
                    placeholder="Enter new password"
                  />
                  <PasswordField
                    label="Confirm New Password"
                    value={passwordForm.confirm_password}
                    onChange={(value) => setPasswordForm({ ...passwordForm, confirm_password: value })}
                    placeholder="Confirm new password"
                  />
                </div>

                {passwordFeedback && (
                  <FeedbackAlert type={passwordFeedback.type} message={passwordFeedback.message} className="mt-3 max-w-sm" />
                )}

                <div className="flex justify-end mt-4">
                  <SaveButton
                    onClick={handleChangePassword}
                    saving={changingPassword}
                    disabled={!passwordForm.current_password || !passwordForm.new_password || !passwordForm.confirm_password}
                    icon={<LockClosedIcon className="w-3.5 h-3.5" />}
                  >
                    Update Password
                  </SaveButton>
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
