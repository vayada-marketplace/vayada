'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
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
import { settingsService, customDomainService, type PropertySettings, type CustomDomainStatus } from '@/services/settings'
import { CURRENCY_OPTIONS, LANGUAGE_OPTIONS, POPULAR_CURRENCY_CODES, POPULAR_LANGUAGE_CODES } from '@/lib/constants/options'
import type { CurrencyOption, LanguageOption } from '@/lib/constants/options'
import { ToggleSwitch, FeedbackAlert, PasswordField, SaveButton } from '@/components/ui'

type Tab = 'property' | 'notifications' | 'security' | 'billing'

const DEFAULT_SETTINGS: PropertySettings = {
  slug: '',
  property_name: '',
  reservation_email: '',
  phone_number: '',
  whatsapp_number: '',
  address: '',
  default_currency: 'EUR',
  default_language: 'en',
  supported_currencies: [],
  supported_languages: [],
  check_in_time: '15:00',
  check_out_time: '11:00',
  pay_at_property_enabled: false,
  online_card_payment: false,
  bank_transfer: false,
  free_cancellation_days: 7,
  email_notifications: true,
  new_booking_alerts: true,
  payment_alerts: true,
  billing_active_plan: 'commission',
  billing_commission_rate: 5,
  billing_fixed_fee: 49,
  billing_pending_switch: null,
  payout_account_holder: '',
  payout_iban: '',
  payout_bank_name: '',
  payout_swift: '',
  refer_a_guest_enabled: false,
}

// ── Custom Select Dropdown ───────────────────────────────────────────
function FlagSelect<T extends { code: string; flag: string }>({
  value,
  onChange,
  options,
  getLabel,
}: {
  value: string
  onChange: (code: string) => void
  options: T[]
  getLabel: (opt: T) => string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const selected = options.find((o) => o.code === value)

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white text-gray-900"
      >
        <span>{selected ? `${selected.flag} ${getLabel(selected)}` : 'Select...'}</span>
        <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
          {options.map((opt) => (
            <button
              key={opt.code}
              type="button"
              onClick={() => { onChange(opt.code); setOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-[13px] text-left hover:bg-gray-50 ${opt.code === value ? 'bg-gray-50 font-medium' : ''}`}
            >
              {opt.code === value && (
                <svg className="w-3.5 h-3.5 text-gray-700 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              )}
              {opt.code !== value && <span className="w-3.5 flex-shrink-0" />}
              <span>{opt.flag} {getLabel(opt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Searchable Multi-Select ──────────────────────────────────────────
function SearchableMultiSelect<T extends { code: string; flag: string }>({
  selected,
  onToggle,
  options,
  excludeCode,
  placeholder,
  getLabel,
  getSearchLabel,
  popularCodes,
  emptyMessage,
}: {
  selected: string[]
  onToggle: (code: string) => void
  options: T[]
  excludeCode: string
  placeholder: string
  getLabel: (opt: T) => string
  getSearchLabel: (opt: T) => string
  popularCodes: string[]
  emptyMessage: string
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const available = options.filter((o) => o.code !== excludeCode)
  const filtered = query.trim()
    ? available.filter((o) => getSearchLabel(o).toLowerCase().includes(query.toLowerCase()))
    : available
  const popular = available.filter((o) => popularCodes.includes(o.code))

  return (
    <div ref={ref}>
      {/* Search input */}
      <div className="relative">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="w-full pl-9 pr-3 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white text-gray-900 placeholder:text-gray-400"
        />
        {/* Dropdown */}
        {open && query.trim() && (
          <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-[13px] text-gray-400">No results found</p>
            ) : (
              filtered.map((opt) => {
                const isSelected = selected.includes(opt.code)
                return (
                  <button
                    key={opt.code}
                    type="button"
                    onClick={() => { onToggle(opt.code); setQuery(''); setOpen(false) }}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-[13px] text-left transition-colors ${isSelected ? 'bg-primary-500 text-white' : 'hover:bg-gray-50 text-gray-900'}`}
                  >
                    <span>{opt.flag}</span>
                    <span>{getSearchLabel(opt)}</span>
                  </button>
                )
              })
            )}
          </div>
        )}
      </div>

      {/* Popular choices */}
      <div className="mt-2">
        <p className="text-[11px] text-gray-400 font-medium mb-1.5">Popular choices &mdash;</p>
        <div className="flex flex-wrap gap-1.5">
          {popular.map((opt) => {
            const isSelected = selected.includes(opt.code)
            return (
              <button
                key={opt.code}
                type="button"
                onClick={() => onToggle(opt.code)}
                className={`inline-flex items-center gap-1 px-2.5 py-0.5 text-[11px] font-medium rounded-full transition-colors ${
                  isSelected
                    ? 'bg-primary-100 text-primary-700 border border-primary-300'
                    : 'bg-gray-50 text-gray-600 border border-gray-200 hover:bg-gray-100'
                }`}
              >
                {opt.flag} {getLabel(opt)}
              </button>
            )
          })}
        </div>
      </div>

      {/* Added items */}
      {selected.length > 0 ? (
        <div className="mt-2">
          <p className="text-[11px] text-gray-400 font-medium mb-1.5">Added ({selected.length}):</p>
          <div className="flex flex-wrap gap-1.5">
            {selected.map((code) => {
              const opt = options.find((o) => o.code === code)
              if (!opt) return null
              return (
                <span
                  key={code}
                  className="inline-flex items-center gap-1 px-2.5 py-0.5 text-[11px] font-medium rounded-full bg-primary-100 text-primary-700 border border-primary-300"
                >
                  {opt.flag} {getLabel(opt)}
                  <button
                    type="button"
                    onClick={() => onToggle(code)}
                    className="ml-0.5 text-primary-400 hover:text-primary-600"
                  >
                    &times;
                  </button>
                </span>
              )
            })}
          </div>
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-gray-400 italic">{emptyMessage}</p>
      )}
    </div>
  )
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('property')
  const [settings, setSettings] = useState<PropertySettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  // Email form state
  const [emailForm, setEmailForm] = useState({ new_email: '', password: '' })
  const [changingEmail, setChangingEmail] = useState(false)
  const [emailFeedback, setEmailFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  // Password form state
  const [passwordForm, setPasswordForm] = useState({ current_password: '', new_password: '', confirm_password: '' })
  const [changingPassword, setChangingPassword] = useState(false)
  const [passwordFeedback, setPasswordFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  // Custom domain
  const [domainInput, setDomainInput] = useState('')
  const [domainStatus, setDomainStatus] = useState<CustomDomainStatus | null>(null)
  const [domainLoading, setDomainLoading] = useState(false)

  // Stripe Connect / Payments
  const [stripeAccountId, setStripeAccountId] = useState<string | null>(null)
  const [stripeOnboarded, setStripeOnboarded] = useState(false)
  const [connectEmail, setConnectEmail] = useState('')
  const [connectCountry, setConnectCountry] = useState('AT')
  const [creatingAccount, setCreatingAccount] = useState(false)
  const [paymentProvider, setPaymentProvider] = useState<'stripe' | 'xendit'>('stripe')
  const [xenditChannelCode, setXenditChannelCode] = useState('ID_BCA')
  const [xenditAccountNumber, setXenditAccountNumber] = useState('')
  const [xenditAccountHolderName, setXenditAccountHolderName] = useState('')
  const [paymentError, setPaymentError] = useState('')
  const [paymentSuccess, setPaymentSuccess] = useState('')
  const [savingPayment, setSavingPayment] = useState(false)

  const handleChangeEmail = async () => {
    try {
      setChangingEmail(true)
      setEmailFeedback(null)
      const res = await settingsService.changeEmail(emailForm.new_email, emailForm.password)
      setEmailFeedback({ type: 'success', message: res.message || 'A verification link has been sent to your new email address.' })
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
    customDomainService.getStatus()
      .then(setDomainStatus)
      .catch(() => {})
    // Load payment settings from PMS
    pmsClient.get<{ paymentSettings: any }>('/admin/payment-settings')
      .then((res) => {
        const ps = res.paymentSettings
        setStripeAccountId(ps.stripeConnectAccountId)
        setStripeOnboarded(ps.stripeConnectOnboarded)
        setPaymentProvider(ps.paymentProvider || 'stripe')
        setXenditChannelCode(ps.xenditChannelCode || 'ID_BCA')
        setXenditAccountNumber(ps.xenditAccountNumber || '')
        setXenditAccountHolderName(ps.xenditAccountHolderName || '')
      })
      .catch(() => {})
  }, [fetchSettings])

  const handleCreateStripeAccount = async () => {
    if (!connectEmail) return
    setCreatingAccount(true)
    setPaymentError('')
    try {
      const result = await pmsClient.post<{ accountId: string }>('/admin/stripe/connect-account', { email: connectEmail, country: connectCountry })
      setStripeAccountId(result.accountId)
      const link = await pmsClient.get<{ url: string }>('/admin/stripe/connect-onboarding-link')
      window.open(link.url, '_blank')
    } catch (err: any) {
      setPaymentError(err.message || 'Failed to create account')
    } finally {
      setCreatingAccount(false)
    }
  }

  const handleOnboarding = async () => {
    try {
      const link = await pmsClient.get<{ url: string }>('/admin/stripe/connect-onboarding-link')
      window.open(link.url, '_blank')
    } catch (err: any) {
      setPaymentError(err.message || 'Failed to get onboarding link')
    }
  }

  const savePaymentProviderSettings = async () => {
    setSavingPayment(true)
    setPaymentError('')
    setPaymentSuccess('')
    if (paymentProvider === 'xendit') {
      if (!xenditAccountNumber.trim() || !/^\d{5,20}$/.test(xenditAccountNumber.trim())) {
        setPaymentError('Account number must be 5-20 digits')
        setSavingPayment(false)
        return
      }
      if (!xenditAccountHolderName.trim()) {
        setPaymentError('Account holder name is required')
        setSavingPayment(false)
        return
      }
    }
    try {
      await pmsClient.patch('/admin/payment-settings', {
        paymentProvider,
        ...(paymentProvider === 'xendit' ? { xenditChannelCode, xenditAccountNumber, xenditAccountHolderName } : {}),
      })
      setPaymentSuccess('Payment settings saved')
    } catch (err: any) {
      setPaymentError(err.message || 'Failed to save')
    } finally {
      setSavingPayment(false)
    }
  }

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
        // Non-fatal: PMS sync may fail if not using vayada PMS
      }
      setFeedback({ type: 'success', message: 'Settings saved successfully' })
    } catch {
      setFeedback({ type: 'error', message: 'Failed to save settings' })
    } finally {
      setSaving(false)
    }
  }

  const toggleCurrency = (code: string) => {
    setSettings({
      ...settings,
      supported_currencies: settings.supported_currencies.includes(code)
        ? settings.supported_currencies.filter((c) => c !== code)
        : [...settings.supported_currencies, code],
    })
  }

  const toggleLanguage = (code: string) => {
    setSettings({
      ...settings,
      supported_languages: settings.supported_languages.includes(code)
        ? settings.supported_languages.filter((l) => l !== code)
        : [...settings.supported_languages, code],
    })
  }

  const updateSetting = <K extends keyof PropertySettings>(key: K, value: PropertySettings[K]) => {
    setSettings({ ...settings, [key]: value })
  }

  const handleConnectDomain = async () => {
    if (!domainInput.trim()) return
    setDomainLoading(true)
    setFeedback(null)
    try {
      const connectedDomain = domainInput.trim().toLowerCase()
      await customDomainService.connect(connectedDomain)
      setDomainStatus({
        configured: true,
        domain: connectedDomain,
        status: 'pending',
        ssl_status: 'initializing',
      })
      setDomainInput('')
      setFeedback({ type: 'success', message: 'Custom domain connected. Add the DNS record below to activate it.' })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to connect domain'
      setFeedback({ type: 'error', message })
    } finally {
      setDomainLoading(false)
    }
  }

  const handleDisconnectDomain = async () => {
    setDomainLoading(true)
    setFeedback(null)
    try {
      await customDomainService.disconnect()
      setDomainStatus({ configured: false })
      setFeedback({ type: 'success', message: 'Custom domain removed' })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to remove domain'
      setFeedback({ type: 'error', message })
    } finally {
      setDomainLoading(false)
    }
  }

  const handleRefreshDomainStatus = async () => {
    try {
      const status = await customDomainService.getStatus()
      setDomainStatus(status)
    } catch {}
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

                  {/* Social Media card */}
                  <div className="bg-white rounded-lg border border-gray-200 p-5">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <GlobeAltIcon className="w-4 h-4 text-gray-700" />
                      <h2 className="text-sm font-semibold text-gray-900">Social Media</h2>
                    </div>
                    <p className="text-[13px] text-gray-500 mb-3">Links shown in your booking site footer</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[13px] font-medium text-gray-700 mb-0.5">Instagram</label>
                        <input
                          type="url"
                          value={settings.instagram || ''}
                          onChange={(e) => updateSetting('instagram', e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                          placeholder="https://instagram.com/yourhotel"
                        />
                      </div>
                      <div>
                        <label className="block text-[13px] font-medium text-gray-700 mb-0.5">Facebook</label>
                        <input
                          type="url"
                          value={settings.facebook || ''}
                          onChange={(e) => updateSetting('facebook', e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                          placeholder="https://facebook.com/yourhotel"
                        />
                      </div>
                      <div>
                        <label className="block text-[13px] font-medium text-gray-700 mb-0.5">TikTok</label>
                        <input
                          type="url"
                          value={settings.tiktok || ''}
                          onChange={(e) => updateSetting('tiktok', e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                          placeholder="https://www.tiktok.com/@yourhotel"
                        />
                      </div>
                      <div>
                        <label className="block text-[13px] font-medium text-gray-700 mb-0.5">YouTube</label>
                        <input
                          type="url"
                          value={settings.youtube || ''}
                          onChange={(e) => updateSetting('youtube', e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                          placeholder="https://youtube.com/@yourhotel"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Currency & Languages card */}
                  <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
                    <div className="flex items-center gap-1.5">
                      <GlobeAltIcon className="w-4 h-4 text-gray-700" />
                      <h2 className="text-sm font-semibold text-gray-900">Currency & Languages</h2>
                    </div>

                    {/* Default Currency & Language */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[13px] font-medium text-gray-700 mb-0.5">Default Currency <span className="text-gray-700">*</span></label>
                        <FlagSelect<CurrencyOption>
                          value={settings.default_currency}
                          onChange={(code) => {
                            setSettings({
                              ...settings,
                              default_currency: code,
                              supported_currencies: settings.supported_currencies.filter((c) => c !== code),
                            })
                          }}
                          options={CURRENCY_OPTIONS}
                          getLabel={(o) => o.name}
                        />
                      </div>
                      <div>
                        <label className="block text-[13px] font-medium text-gray-700 mb-0.5">Default Language <span className="text-gray-700">*</span></label>
                        <FlagSelect<LanguageOption>
                          value={settings.default_language || 'en'}
                          onChange={(code) => {
                            setSettings({
                              ...settings,
                              default_language: code,
                              supported_languages: settings.supported_languages.filter((l) => l !== code),
                            })
                          }}
                          options={LANGUAGE_OPTIONS}
                          getLabel={(o) => o.name}
                        />
                      </div>
                    </div>

                    {/* Additional Currencies */}
                    <div>
                      <label className="block text-[13px] text-gray-700 mb-1">
                        <span className="font-medium">Additional Currencies</span> <span className="text-gray-400 font-normal text-[11px]">(optional)</span>
                      </label>
                      <SearchableMultiSelect<CurrencyOption>
                        selected={settings.supported_currencies}
                        onToggle={toggleCurrency}
                        options={CURRENCY_OPTIONS}
                        excludeCode={settings.default_currency}
                        placeholder={`Search currencies, e.g. "Swiss" or "CHF"...`}
                        getLabel={(o) => o.code}
                        getSearchLabel={(o) => `${o.name} \u00b7 ${o.code}`}
                        popularCodes={POPULAR_CURRENCY_CODES}
                        emptyMessage={`No additional currencies added \u2014 your booking page will show only ${settings.default_currency}`}
                      />
                    </div>

                    {/* Additional Languages */}
                    <div>
                      <label className="block text-[13px] text-gray-700 mb-1">
                        <span className="font-medium">Additional Languages</span> <span className="text-gray-400 font-normal text-[11px]">(optional)</span>
                      </label>
                      <SearchableMultiSelect<LanguageOption>
                        selected={settings.supported_languages}
                        onToggle={toggleLanguage}
                        options={LANGUAGE_OPTIONS}
                        excludeCode={settings.default_language || 'en'}
                        placeholder={`Search languages, e.g. "German" or "Deutsch"...`}
                        getLabel={(o) => o.nativeName}
                        getSearchLabel={(o) => `${o.name} \u00b7 ${o.nativeName}`}
                        popularCodes={POPULAR_LANGUAGE_CODES}
                        emptyMessage={`No additional languages added \u2014 your booking page will show only ${(settings.default_language || 'en').toUpperCase()}`}
                      />
                    </div>
                  </div>

                  {/* Refer a Guest */}
                  <div className="bg-white rounded-lg border border-gray-200 p-5">
                    <ToggleSwitch
                      enabled={settings.refer_a_guest_enabled ?? false}
                      onChange={() => updateSetting('refer_a_guest_enabled', !settings.refer_a_guest_enabled)}
                      label={'"Refer a Guest" Feature'}
                      description="Allow guests to refer friends and earn rewards through your booking page"
                    />
                  </div>

                  {/* Custom Domain */}
                  <div className="bg-white rounded-lg border border-gray-200 p-5">
                    <h2 className="text-sm font-semibold text-gray-900">Custom Domain</h2>
                    {domainStatus?.configured ? (
                      <div className="space-y-4 mt-3">
                        <div className="flex items-center gap-3">
                          <span className="text-[13px] font-medium text-gray-900">{domainStatus.domain}</span>
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium ${
                            domainStatus.ssl_status === 'active'
                              ? 'bg-green-100 text-green-700'
                              : domainStatus.status === 'pending'
                              ? 'bg-yellow-100 text-yellow-700'
                              : 'bg-gray-100 text-gray-700'
                          }`}>
                            {domainStatus.ssl_status === 'active' ? 'Active' : domainStatus.status === 'pending' ? 'Pending DNS' : domainStatus.ssl_status || 'Checking...'}
                          </span>
                          <button
                            onClick={handleRefreshDomainStatus}
                            className="text-[11px] text-primary-600 hover:text-primary-700"
                          >
                            Refresh
                          </button>
                        </div>

                        {domainStatus.ssl_status !== 'active' && (
                          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                            <p className="text-[13px] font-medium text-blue-900 mb-2">DNS Setup Required</p>
                            <p className="text-[13px] text-blue-700 mb-2">Add a CNAME record in your DNS provider:</p>
                            <div className="bg-white rounded p-3 font-mono text-[11px] text-gray-800 space-y-1">
                              <div><span className="text-gray-500">Type:</span> CNAME</div>
                              <div><span className="text-gray-500">Name:</span> {domainStatus.domain}</div>
                              <div><span className="text-gray-500">Target:</span> custom.booking.vayada.com</div>
                            </div>
                          </div>
                        )}

                        {domainStatus.verification_errors && domainStatus.verification_errors.length > 0 && (
                          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                            <p className="text-[13px] text-red-700">{domainStatus.verification_errors.join(', ')}</p>
                          </div>
                        )}

                        <button
                          onClick={handleDisconnectDomain}
                          disabled={domainLoading}
                          className="px-4 py-2 text-[13px] font-medium text-red-600 border border-red-300 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors"
                        >
                          {domainLoading ? 'Removing...' : 'Remove Domain'}
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-3 mt-1">
                        <p className="text-[13px] text-gray-500">
                          Use your own domain for your booking page instead of the default subdomain.
                        </p>
                        <div className="flex gap-3">
                          <input
                            type="text"
                            value={domainInput}
                            onChange={(e) => setDomainInput(e.target.value)}
                            placeholder="booking.yourdomain.com"
                            className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                          />
                          <button
                            onClick={handleConnectDomain}
                            disabled={domainLoading || !domainInput.trim()}
                            className="px-4 py-2 text-[13px] font-medium bg-primary-500 text-white rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors"
                          >
                            {domainLoading ? 'Connecting...' : 'Connect Domain'}
                          </button>
                        </div>
                      </div>
                    )}
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
              <div className="grid grid-cols-2 gap-4">
                {/* Commission Plan */}
                <div className={`bg-white rounded-lg border-2 p-5 transition-all ${
                  settings.billing_active_plan === 'commission' && !settings.billing_pending_switch
                    ? 'border-primary-500 ring-1 ring-primary-200'
                    : settings.billing_pending_switch === 'commission'
                      ? 'border-amber-400 ring-1 ring-amber-200'
                      : 'border-gray-200'
                }`}>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-[14px] font-semibold text-gray-900">Commission</h3>
                    {settings.billing_active_plan === 'commission' && !settings.billing_pending_switch && (
                      <span className="px-2 py-0.5 text-[10px] font-bold bg-green-100 text-green-700 rounded-full">CURRENT</span>
                    )}
                    {settings.billing_pending_switch === 'commission' && (
                      <span className="px-2 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-700 rounded-full">NEXT MONTH</span>
                    )}
                  </div>
                  <p className="text-[12px] text-gray-500 mb-3">Percentage of each booking</p>
                  <div className="bg-gray-50 rounded-xl p-4 text-center mb-4">
                    <span className="text-3xl font-bold text-gray-900">{settings.billing_commission_rate || 5}%</span>
                    <p className="text-[11px] text-gray-400 mt-1">per booking</p>
                  </div>
                  {settings.billing_active_plan !== 'commission' && !settings.billing_pending_switch && (
                    <button
                      onClick={async () => {
                        try {
                          await settingsService.updatePropertySettings({ billing_pending_switch: 'commission' })
                          setSettings(s => ({ ...s, billing_pending_switch: 'commission' }))
                        } catch { /* */ }
                      }}
                      className="w-full py-2 text-[12px] font-semibold border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      Switch from next month
                    </button>
                  )}
                  {settings.billing_pending_switch === 'commission' && (
                    <button
                      onClick={async () => {
                        try {
                          await settingsService.updatePropertySettings({ billing_pending_switch: '' })
                          setSettings(s => ({ ...s, billing_pending_switch: null }))
                        } catch { /* */ }
                      }}
                      className="w-full py-2 text-[12px] font-semibold border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 transition-colors"
                    >
                      Cancel switch
                    </button>
                  )}
                </div>

                {/* Fixed Fee Plan */}
                <div className={`bg-white rounded-lg border-2 p-5 transition-all ${
                  settings.billing_active_plan === 'fixed' && !settings.billing_pending_switch
                    ? 'border-primary-500 ring-1 ring-primary-200'
                    : settings.billing_pending_switch === 'fixed'
                      ? 'border-amber-400 ring-1 ring-amber-200'
                      : 'border-gray-200'
                }`}>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-[14px] font-semibold text-gray-900">Fixed Fee</h3>
                    {settings.billing_active_plan === 'fixed' && !settings.billing_pending_switch && (
                      <span className="px-2 py-0.5 text-[10px] font-bold bg-green-100 text-green-700 rounded-full">CURRENT</span>
                    )}
                    {settings.billing_pending_switch === 'fixed' && (
                      <span className="px-2 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-700 rounded-full">NEXT MONTH</span>
                    )}
                  </div>
                  <p className="text-[12px] text-gray-500 mb-3">Flat monthly subscription</p>
                  <div className="bg-gray-50 rounded-xl p-4 text-center mb-4">
                    <span className="text-3xl font-bold text-gray-900">{new Intl.NumberFormat('en-US', { style: 'currency', currency: settings.default_currency || 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(settings.billing_fixed_fee || 49)}</span>
                    <p className="text-[11px] text-gray-400 mt-1">per month</p>
                  </div>
                  {settings.billing_active_plan !== 'fixed' && !settings.billing_pending_switch && (
                    <button
                      onClick={async () => {
                        try {
                          await settingsService.updatePropertySettings({ billing_pending_switch: 'fixed' })
                          setSettings(s => ({ ...s, billing_pending_switch: 'fixed' }))
                        } catch { /* */ }
                      }}
                      className="w-full py-2 text-[12px] font-semibold border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      Switch from next month
                    </button>
                  )}
                  {settings.billing_pending_switch === 'fixed' && (
                    <button
                      onClick={async () => {
                        try {
                          await settingsService.updatePropertySettings({ billing_pending_switch: '' })
                          setSettings(s => ({ ...s, billing_pending_switch: null }))
                        } catch { /* */ }
                      }}
                      className="w-full py-2 text-[12px] font-semibold border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 transition-colors"
                    >
                      Cancel switch
                    </button>
                  )}
                </div>
              </div>

              {settings.billing_pending_switch && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                  <p className="text-[13px] text-amber-800">
                    Your plan will switch to <strong>{settings.billing_pending_switch === 'commission' ? 'Commission' : 'Fixed Fee'}</strong> at the start of next month.
                  </p>
                </div>
              )}

              {/* Payment Methods */}
              <div className="bg-white rounded-lg border border-gray-200 p-5">
                <h2 className="text-sm font-semibold text-gray-900">Payment Methods</h2>
                <p className="text-[12px] text-gray-500 mt-0.5 mb-4">Choose which payment options are available to guests. Enable multiple to give guests flexibility.</p>
                <div className="grid grid-cols-3 gap-3">
                  {/* Online Card Payment */}
                  <button
                    onClick={() => updateSetting('online_card_payment', !settings.online_card_payment)}
                    className={`relative flex flex-col p-4 rounded-xl border-2 transition-all text-left ${
                      settings.online_card_payment
                        ? 'border-primary-500 bg-primary-50/30'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className={`absolute top-3 right-3 w-5 h-5 rounded-full border-2 flex items-center justify-center ${settings.online_card_payment ? 'border-primary-500 bg-primary-500' : 'border-gray-300'}`}>
                      {settings.online_card_payment && <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                    </div>
                    <svg className="w-6 h-6 text-gray-700 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>
                    <span className="text-[13px] font-semibold text-gray-900">Online Card</span>
                    <p className="text-[11px] text-gray-500 mt-1 mb-3">Guest pays online with credit or debit card via Stripe</p>
                    <div className="mt-auto space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <svg className="w-3 h-3 text-green-500 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                        <span className="text-[10px] text-gray-500">Instant confirmation</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <svg className="w-3 h-3 text-green-500 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                        <span className="text-[10px] text-gray-500">Visa, Mastercard, Amex</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <svg className="w-3 h-3 text-green-500 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                        <span className="text-[10px] text-gray-500">Auto payout to your bank</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <svg className="w-3 h-3 text-amber-500 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" /></svg>
                        <span className="text-[10px] text-gray-500">Stripe fees apply (~2.9%)</span>
                      </div>
                    </div>
                  </button>

                  {/* Pay at Hotel */}
                  <button
                    onClick={() => updateSetting('pay_at_property_enabled', !settings.pay_at_property_enabled)}
                    className={`relative flex flex-col p-4 rounded-xl border-2 transition-all text-left ${
                      settings.pay_at_property_enabled
                        ? 'border-primary-500 bg-primary-50/30'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className={`absolute top-3 right-3 w-5 h-5 rounded-full border-2 flex items-center justify-center ${settings.pay_at_property_enabled ? 'border-primary-500 bg-primary-500' : 'border-gray-300'}`}>
                      {settings.pay_at_property_enabled && <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                    </div>
                    <svg className="w-6 h-6 text-gray-700 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                    <span className="text-[13px] font-semibold text-gray-900">Pay at Hotel</span>
                    <p className="text-[11px] text-gray-500 mt-1 mb-3">Guest pays cash or card at check-in — no online payment</p>
                    <div className="mt-auto space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <svg className="w-3 h-3 text-green-500 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                        <span className="text-[10px] text-gray-500">No processing fees</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <svg className="w-3 h-3 text-green-500 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                        <span className="text-[10px] text-gray-500">Cash & card accepted</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <svg className="w-3 h-3 text-green-500 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                        <span className="text-[10px] text-gray-500">No Stripe account needed</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <svg className="w-3 h-3 text-amber-500 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" /></svg>
                        <span className="text-[10px] text-gray-500">Higher no-show risk</span>
                      </div>
                    </div>
                  </button>

                  {/* Bank Transfer */}
                  <button
                    onClick={() => updateSetting('bank_transfer', !settings.bank_transfer)}
                    className={`relative flex flex-col p-4 rounded-xl border-2 transition-all text-left ${
                      settings.bank_transfer
                        ? 'border-primary-500 bg-primary-50/30'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className={`absolute top-3 right-3 w-5 h-5 rounded-full border-2 flex items-center justify-center ${settings.bank_transfer ? 'border-primary-500 bg-primary-500' : 'border-gray-300'}`}>
                      {settings.bank_transfer && <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                    </div>
                    <svg className="w-6 h-6 text-gray-700 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 14v3m4-3v3m4-3v3M3 21h18M3 10h18M3 7l9-4 9 4M4 10h16v11H4V10z" /></svg>
                    <span className="text-[13px] font-semibold text-gray-900">Bank Transfer</span>
                    <p className="text-[11px] text-gray-500 mt-1 mb-3">Guest transfers money directly to your bank account</p>
                    <div className="mt-auto space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <svg className="w-3 h-3 text-green-500 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                        <span className="text-[10px] text-gray-500">No processing fees</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <svg className="w-3 h-3 text-green-500 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                        <span className="text-[10px] text-gray-500">Direct to your account</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <svg className="w-3 h-3 text-green-500 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                        <span className="text-[10px] text-gray-500">Good for large bookings</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <svg className="w-3 h-3 text-amber-500 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" /></svg>
                        <span className="text-[10px] text-gray-500">Manual verification needed</span>
                      </div>
                    </div>
                  </button>
                </div>
                <div className="flex justify-end pt-4">
                  <SaveButton onClick={handleSave} saving={saving} />
                </div>
              </div>

              {/* Payments — Stripe Connect / Xendit */}
              {settings.online_card_payment && <div className="bg-white rounded-lg border border-gray-200 p-5">
                <h2 className="text-sm font-semibold text-gray-900">Payments</h2>
                <p className="text-[12px] text-gray-500 mt-0.5 mb-4">
                  {paymentProvider === 'xendit'
                    ? 'Receive payouts from guest bookings directly to your Indonesian bank account via Xendit.'
                    : 'Accept credit card payments from guests via Stripe. Payouts are sent automatically to your connected bank account.'}
                </p>

                {paymentError && (
                  <FeedbackAlert type="error" message={paymentError} className="mb-3" />
                )}
                {paymentSuccess && (
                  <FeedbackAlert type="success" message={paymentSuccess} className="mb-3" />
                )}

                {paymentProvider === 'xendit' ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Bank</label>
                        <select value={xenditChannelCode} onChange={(e) => setXenditChannelCode(e.target.value)} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500">
                          <option value="ID_BCA">BCA</option>
                          <option value="ID_MANDIRI">Mandiri</option>
                          <option value="ID_BNI">BNI</option>
                          <option value="ID_BRI">BRI</option>
                          <option value="ID_PERMATA">Permata</option>
                          <option value="ID_CIMB">CIMB Niaga</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Account Number</label>
                        <input type="text" inputMode="numeric" maxLength={20} value={xenditAccountNumber} onChange={(e) => setXenditAccountNumber(e.target.value.replace(/\D/g, ''))} placeholder="1234567890" className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500" />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Account Holder Name</label>
                      <input type="text" value={xenditAccountHolderName} onChange={(e) => setXenditAccountHolderName(e.target.value)} placeholder="Full name as on bank account" className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500" />
                    </div>
                    <div className="flex justify-end pt-2">
                      <SaveButton onClick={savePaymentProviderSettings} saving={savingPayment} />
                    </div>
                  </div>
                ) : stripeAccountId ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-semibold text-gray-700">Stripe</span>
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium ${stripeOnboarded ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                        {stripeOnboarded ? 'Connected' : 'Pending Onboarding'}
                      </span>
                    </div>
                    {!stripeOnboarded && (
                      <div>
                        <p className="text-[13px] text-gray-600 mb-2">Complete your onboarding to start accepting card payments.</p>
                        <button onClick={handleOnboarding} className="px-4 py-2 text-[13px] font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors">
                          Complete Onboarding
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 mb-1">
                      <div className="flex items-center gap-2">
                        <svg className="h-5" viewBox="0 0 60 25" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M60 12.8C60 8.5 57.9 5 54.4 5c-3.5 0-5.9 3.5-5.9 7.8s2.2 7.8 5.8 7.8c1.7 0 3-.4 4-1.1v-2.7c-1 .5-2.1.9-3.5.9-1.4 0-2.6-.5-2.8-2.2h6.9c0-.2.1-1 .1-1.7zm-7-1.4c0-1.6 1-2.3 1.9-2.3.9 0 1.8.7 1.8 2.3h-3.7zm-7.5-6.4c-1.4 0-2.3.7-2.8 1.1l-.2-.9h-3.1v19.7l3.5-.7.1-4.8c.5.4 1.3.9 2.5.9 2.5 0 4.8-2 4.8-6.5 0-4.1-2.4-6.8-4.8-6.8zm-.8 10.5c-.8 0-1.3-.3-1.7-.7l-.1-5.4c.4-.4.9-.7 1.7-.7 1.3 0 2.2 1.5 2.2 3.4.1 2-.9 3.4-2.1 3.4zM35.2 5l3.5-.8V1.5l-3.5.7V5zm0 .5h3.5v14.2h-3.5V5.5zM31.3 6.3l-.2-1H28v14.2h3.5V9.1c.8-1.1 2.2-.9 2.6-.7V5.5c-.5-.2-2.2-.5-2.8 1zm-7.4-3.8l-3.4.7-.1 13c0 2.4 1.8 4.2 4.2 4.2 1.3 0 2.3-.2 2.8-.5v-2.8c-.5.2-3.1.9-3.1-1.4V8.3h3.1V5.5h-3.1l-.4-3zm-8.8 8c0-.6.5-.8 1.3-.8 1.1 0 2.5.3 3.7 1V7.4c-1.2-.5-2.5-.7-3.7-.7-3 0-5 1.6-5 4.2 0 4.1 5.7 3.5 5.7 5.2 0 .7-.6.9-1.5.9-1.3 0-2.9-.5-4.2-1.2v3.2c1.4.6 2.9.9 4.2.9 3.1 0 5.2-1.5 5.2-4.2-.1-4.5-5.7-3.7-5.7-5.3z" fill="#635BFF"/></svg>
                        <p className="text-[11px] text-gray-500">Secure payments processed by Stripe. Payouts go directly to your bank account.</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Email</label>
                        <input type="email" value={connectEmail} onChange={(e) => setConnectEmail(e.target.value)} placeholder="your@email.com" className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500" />
                      </div>
                      <div>
                        <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Country</label>
                        <select value={connectCountry} onChange={(e) => setConnectCountry(e.target.value)} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500">
                          {[{c:'AT',n:'Austria'},{c:'DE',n:'Germany'},{c:'CH',n:'Switzerland'},{c:'GB',n:'United Kingdom'},{c:'US',n:'United States'},{c:'FR',n:'France'},{c:'ES',n:'Spain'},{c:'IT',n:'Italy'},{c:'NL',n:'Netherlands'},{c:'PT',n:'Portugal'},{c:'BE',n:'Belgium'},{c:'SE',n:'Sweden'},{c:'NO',n:'Norway'},{c:'DK',n:'Denmark'},{c:'FI',n:'Finland'},{c:'IE',n:'Ireland'},{c:'AU',n:'Australia'},{c:'NZ',n:'New Zealand'},{c:'CA',n:'Canada'},{c:'SG',n:'Singapore'},{c:'HK',n:'Hong Kong'},{c:'JP',n:'Japan'},{c:'MY',n:'Malaysia'},{c:'TH',n:'Thailand'},{c:'ID',n:'Indonesia'},{c:'PH',n:'Philippines'},{c:'MX',n:'Mexico'},{c:'BR',n:'Brazil'},{c:'IN',n:'India'}].map(({c,n}) => (
                            <option key={c} value={c}>{n}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <button onClick={handleCreateStripeAccount} disabled={creatingAccount || !connectEmail} className="px-4 py-2 text-[13px] font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors">
                      {creatingAccount ? 'Connecting...' : 'Connect with Stripe'}
                    </button>
                  </div>
                )}
              </div>}

              {/* Payout Details */}
              {(settings.pay_at_property_enabled || settings.bank_transfer) && <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-3">
                <div>
                  <h2 className="text-sm font-semibold text-gray-900">Payout Details</h2>
                  <p className="text-[12px] text-gray-500 mt-0.5">Bank account where vayada sends your earnings</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Account Holder Name</label>
                    <input
                      type="text"
                      value={settings.payout_account_holder || ''}
                      onChange={e => updateSetting('payout_account_holder', e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      placeholder="e.g. Sunrise Beach Resort Ltd"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-[12px] font-medium text-gray-700 mb-0.5">IBAN</label>
                    <input
                      type="text"
                      value={settings.payout_iban || ''}
                      onChange={e => updateSetting('payout_iban', e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      placeholder="e.g. GB29 NWBK 6016 1331 9268 19"
                    />
                  </div>
                  <div>
                    <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Bank Name</label>
                    <input
                      type="text"
                      value={settings.payout_bank_name || ''}
                      onChange={e => updateSetting('payout_bank_name', e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      placeholder="e.g. HSBC Bank"
                    />
                  </div>
                  <div>
                    <label className="block text-[12px] font-medium text-gray-700 mb-0.5">SWIFT / BIC</label>
                    <input
                      type="text"
                      value={settings.payout_swift || ''}
                      onChange={e => updateSetting('payout_swift', e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      placeholder="e.g. HBUKGB4B"
                    />
                  </div>
                </div>

                <div className="flex justify-end pt-2">
                  <SaveButton onClick={handleSave} saving={saving} />
                </div>
              </div>}
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
