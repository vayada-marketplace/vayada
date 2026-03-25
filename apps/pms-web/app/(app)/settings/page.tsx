'use client'

import { useState, useEffect, useRef } from 'react'
import { bookingsService, PaymentSettings, CancellationPolicy } from '@/services/bookings'
import { customDomainService, CustomDomainStatus } from '@/services/custom-domain'
import { benefitsService } from '@/services/rooms'
import { PlusIcon, XMarkIcon, CheckIcon } from '@heroicons/react/24/outline'

const CURRENCIES = [
  { value: 'AUD', label: 'AUD — Australian Dollar (A$)' },
  { value: 'CHF', label: 'CHF — Swiss Franc' },
  { value: 'EUR', label: 'EUR — Euro (€)' },
  { value: 'GBP', label: 'GBP — British Pound (£)' },
  { value: 'IDR', label: 'IDR — Indonesian Rupiah (Rp)' },
  { value: 'INR', label: 'INR — Indian Rupee' },
  { value: 'JPY', label: 'JPY — Japanese Yen (¥)' },
  { value: 'KRW', label: 'KRW — South Korean Won' },
  { value: 'MYR', label: 'MYR — Malaysian Ringgit' },
  { value: 'NZD', label: 'NZD — New Zealand Dollar' },
  { value: 'PHP', label: 'PHP — Philippine Peso' },
  { value: 'SGD', label: 'SGD — Singapore Dollar (S$)' },
  { value: 'THB', label: 'THB — Thai Baht (฿)' },
  { value: 'USD', label: 'USD — US Dollar ($)' },
  { value: 'VND', label: 'VND — Vietnamese Dong' },
]

const BENEFIT_OPTIONS = [
  'Welcome Drink on Arrival',
  '10% Spa Discount',
  'Late Check-out (subject to availability)',
  'Early Check-in (subject to availability)',
  'Free Airport Transfer',
  'Daily Breakfast Included',
  'Room Upgrade (subject to availability)',
]

function CurrencySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const filtered = CURRENCIES.filter(
    (c) => c.label.toLowerCase().includes(search.toLowerCase())
  )

  const selectedLabel = CURRENCIES.find((c) => c.value === value)?.label ?? value

  return (
    <div ref={ref} className="relative w-full max-w-xs">
      <button
        type="button"
        onClick={() => { setOpen(!open); setSearch('') }}
        className="w-full px-3 py-2 text-sm text-left border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white flex items-center justify-between"
      >
        <span>{selectedLabel}</span>
        <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-300 rounded-lg shadow-lg">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search currency..."
            autoFocus
            className="w-full px-3 py-2 text-sm border-b border-gray-200 focus:outline-none rounded-t-lg"
          />
          <ul className="max-h-60 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-gray-400">No results</li>
            ) : (
              filtered.map((c) => (
                <li
                  key={c.value}
                  onClick={() => { onChange(c.value); setOpen(false) }}
                  className={`px-3 py-2 text-sm cursor-pointer hover:bg-primary-50 ${c.value === value ? 'bg-primary-50 font-medium text-primary-700' : 'text-gray-700'}`}
                >
                  {c.label}
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

export default function SettingsPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')

  // Custom domain
  const [domainInput, setDomainInput] = useState('')
  const [domainStatus, setDomainStatus] = useState<CustomDomainStatus | null>(null)
  const [domainLoading, setDomainLoading] = useState(false)

  // Currency
  const [currency, setCurrency] = useState('EUR')
  const [savingCurrency, setSavingCurrency] = useState(false)

  // Payment settings
  const [feeType, setFeeType] = useState('percentage')
  const [feeValue, setFeeValue] = useState(8)
  const [feeWithAffiliate, setFeeWithAffiliate] = useState(2)
  const [payAtProperty, setPayAtProperty] = useState(false)

  // Stripe Connect
  const [stripeAccountId, setStripeAccountId] = useState<string | null>(null)
  const [stripeOnboarded, setStripeOnboarded] = useState(false)
  const [connectEmail, setConnectEmail] = useState('')
  const [connectCountry, setConnectCountry] = useState('AT')
  const [creatingAccount, setCreatingAccount] = useState(false)

  // Payment provider
  const [paymentProvider, setPaymentProvider] = useState<'stripe' | 'xendit'>('stripe')
  const [xenditChannelCode, setXenditChannelCode] = useState('ID_BCA')
  const [xenditAccountNumber, setXenditAccountNumber] = useState('')
  const [xenditAccountHolderName, setXenditAccountHolderName] = useState('')

  // Cancellation policy
  const [freeDays, setFreeDays] = useState(7)
  const [partialRefundPct, setPartialRefundPct] = useState(0)

  // Book Direct Benefits
  const [benefits, setBenefits] = useState<string[]>([])
  const [benefitInput, setBenefitInput] = useState('')
  const [savingBenefits, setSavingBenefits] = useState(false)

  useEffect(() => {
    customDomainService.getStatus()
      .then(setDomainStatus)
      .catch(console.error)

    benefitsService.get()
      .then((res) => setBenefits(res.benefits))
      .catch(console.error)

    bookingsService.getPaymentSettings()
      .then((res) => {
        const ps = res.paymentSettings
        setFeeType(ps.platformFeeType)
        setFeeValue(ps.platformFeeValue)
        setFeeWithAffiliate(ps.platformFeeWithAffiliate)
        setPayAtProperty(ps.payAtPropertyEnabled)
        setStripeAccountId(ps.stripeConnectAccountId)
        setStripeOnboarded(ps.stripeConnectOnboarded)
        setCurrency(ps.defaultCurrency || 'EUR')
        setPaymentProvider(ps.paymentProvider || 'stripe')
        setXenditChannelCode(ps.xenditChannelCode || 'ID_BCA')
        setXenditAccountNumber(ps.xenditAccountNumber || '')
        setXenditAccountHolderName(ps.xenditAccountHolderName || '')

        const cp = res.cancellationPolicy
        setFreeDays(cp.freeCancellationDays)
        setPartialRefundPct(cp.partialRefundPct)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const savePaymentSettings = async () => {
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      await bookingsService.updatePaymentSettings({
        platformFeeType: feeType,
        platformFeeValue: feeValue,
        platformFeeWithAffiliate: feeWithAffiliate,
        payAtPropertyEnabled: payAtProperty,
        paymentProvider,
        ...(paymentProvider === 'xendit' ? {
          xenditChannelCode,
          xenditAccountNumber,
          xenditAccountHolderName,
        } : {}),
      })
      setSuccess('Payment settings saved')
    } catch (err: any) {
      setError(err.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const saveCancellationPolicy = async () => {
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      await bookingsService.updateCancellationPolicy({
        freeCancellationDays: freeDays,
        partialRefundPct,
      })
      setSuccess('Cancellation policy saved')
    } catch (err: any) {
      setError(err.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const saveBenefits = async () => {
    setSavingBenefits(true)
    setError('')
    setSuccess('')
    try {
      await benefitsService.update(benefits)
      setSuccess('Book Direct Benefits saved')
    } catch (err: any) {
      setError(err.message || 'Failed to save benefits')
    } finally {
      setSavingBenefits(false)
    }
  }

  const saveCurrency = async () => {
    setSavingCurrency(true)
    setError('')
    setSuccess('')
    try {
      await bookingsService.updatePaymentSettings({ defaultCurrency: currency })
      setSuccess('Currency saved')
    } catch (err: any) {
      setError(err.message || 'Failed to save currency')
    } finally {
      setSavingCurrency(false)
    }
  }

  const handleCreateStripeAccount = async () => {
    if (!connectEmail) return
    setCreatingAccount(true)
    setError('')
    try {
      const result = await bookingsService.createStripeAccount(connectEmail, connectCountry)
      setStripeAccountId(result.accountId)
      // Open onboarding
      const link = await bookingsService.getStripeOnboardingLink()
      window.open(link.url, '_blank')
    } catch (err: any) {
      setError(err.message || 'Failed to create account')
    } finally {
      setCreatingAccount(false)
    }
  }

  const handleConnectDomain = async () => {
    if (!domainInput.trim()) return
    setDomainLoading(true)
    setError('')
    setSuccess('')
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
      setSuccess('Custom domain connected. Add the DNS record below to activate it.')
    } catch (err: any) {
      setError(err.message || 'Failed to connect domain')
    } finally {
      setDomainLoading(false)
    }
  }

  const handleDisconnectDomain = async () => {
    setDomainLoading(true)
    setError('')
    setSuccess('')
    try {
      await customDomainService.disconnect()
      setDomainStatus({ configured: false })
      setSuccess('Custom domain removed')
    } catch (err: any) {
      setError(err.message || 'Failed to remove domain')
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

  const handleOnboarding = async () => {
    try {
      const link = await bookingsService.getStripeOnboardingLink()
      window.open(link.url, '_blank')
    } catch (err: any) {
      setError(err.message || 'Failed to get onboarding link')
    }
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-bold text-gray-900 mb-6">Settings</h1>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
          {success}
        </div>
      )}

      <div className="space-y-8">
        {/* Currency */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Currency</h2>
          <p className="text-xs text-gray-500 mb-4">Choose the display currency for prices across your dashboard.</p>
          <CurrencySelect value={currency} onChange={setCurrency} />
          <button
            onClick={saveCurrency}
            disabled={savingCurrency}
            className="mt-3 block px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            {savingCurrency ? 'Saving...' : 'Save'}
          </button>
        </div>

        {/* Custom Domain */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Custom Domain</h2>
          {domainStatus?.configured ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-gray-900">{domainStatus.domain}</span>
                <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
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
                  className="text-xs text-primary-600 hover:text-primary-700"
                >
                  Refresh
                </button>
              </div>

              {domainStatus.ssl_status !== 'active' && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <p className="text-sm font-medium text-blue-900 mb-2">DNS Setup Required</p>
                  <p className="text-sm text-blue-700 mb-2">Add a CNAME record in your DNS provider:</p>
                  <div className="bg-white rounded p-3 font-mono text-xs text-gray-800 space-y-1">
                    <div><span className="text-gray-500">Type:</span> CNAME</div>
                    <div><span className="text-gray-500">Name:</span> {domainStatus.domain}</div>
                    <div><span className="text-gray-500">Target:</span> custom.booking.vayada.com</div>
                  </div>
                </div>
              )}

              {domainStatus.verification_errors && domainStatus.verification_errors.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-sm text-red-700">{domainStatus.verification_errors.join(', ')}</p>
                </div>
              )}

              <button
                onClick={handleDisconnectDomain}
                disabled={domainLoading}
                className="px-4 py-2 text-sm font-medium text-red-600 border border-red-300 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                {domainLoading ? 'Removing...' : 'Remove Domain'}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-gray-600">
                Use your own domain for your booking page instead of the default subdomain.
              </p>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={domainInput}
                  onChange={(e) => setDomainInput(e.target.value)}
                  placeholder="booking.yourdomain.com"
                  className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
                <button
                  onClick={handleConnectDomain}
                  disabled={domainLoading || !domainInput.trim()}
                  className="px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
                >
                  {domainLoading ? 'Connecting...' : 'Connect Domain'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Payments */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Payments</h2>
          <p className="text-xs text-gray-500 mb-4">Connect your bank account to receive payouts from guest bookings.</p>

          {paymentProvider === 'xendit' ? (
            /* Xendit — Indonesian bank account */
            <div className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Bank</label>
                  <select
                    value={xenditChannelCode}
                    onChange={(e) => setXenditChannelCode(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    <option value="ID_BCA">BCA</option>
                    <option value="ID_MANDIRI">Mandiri</option>
                    <option value="ID_BNI">BNI</option>
                    <option value="ID_BRI">BRI</option>
                    <option value="ID_PERMATA">Permata</option>
                    <option value="ID_CIMB">CIMB Niaga</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Account Number</label>
                  <input
                    type="text"
                    value={xenditAccountNumber}
                    onChange={(e) => setXenditAccountNumber(e.target.value)}
                    placeholder="1234567890"
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Account Holder Name</label>
                <input
                  type="text"
                  value={xenditAccountHolderName}
                  onChange={(e) => setXenditAccountHolderName(e.target.value)}
                  placeholder="Full name as on bank account"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
            </div>
          ) : stripeAccountId ? (
            /* Stripe Connect — already connected */
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${stripeOnboarded ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                  {stripeOnboarded ? 'Connected' : 'Pending Onboarding'}
                </span>
              </div>
              {!stripeOnboarded && (
                <div>
                  <p className="text-sm text-gray-600 mb-2">Complete your onboarding to start accepting card payments.</p>
                  <button
                    onClick={handleOnboarding}
                    className="px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
                  >
                    Complete Onboarding
                  </button>
                </div>
              )}
            </div>
          ) : (
            /* Stripe Connect — not yet connected */
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Email</label>
                  <input
                    type="email"
                    value={connectEmail}
                    onChange={(e) => setConnectEmail(e.target.value)}
                    placeholder="your@email.com"
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Country</label>
                  <select
                    value={connectCountry}
                    onChange={(e) => setConnectCountry(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    <option value="AT">Austria</option>
                    <option value="DE">Germany</option>
                    <option value="CH">Switzerland</option>
                    <option value="US">United States</option>
                    <option value="GB">United Kingdom</option>
                    <option value="FR">France</option>
                    <option value="IT">Italy</option>
                    <option value="ES">Spain</option>
                    <option value="NL">Netherlands</option>
                    <option value="TH">Thailand</option>
                    <option value="AU">Australia</option>
                    <option value="SG">Singapore</option>
                    <option value="JP">Japan</option>
                  </select>
                </div>
              </div>
              <button
                onClick={handleCreateStripeAccount}
                disabled={creatingAccount || !connectEmail}
                className="px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
              >
                {creatingAccount ? 'Creating...' : 'Connect Payment Account'}
              </button>
            </div>
          )}

          <div className="mt-4 pt-4 border-t border-gray-100">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={payAtProperty}
                onChange={(e) => setPayAtProperty(e.target.checked)}
                className="rounded text-primary-600"
              />
              <label className="text-sm text-gray-700">Allow guests to pay at the property (cash/card on arrival)</label>
            </div>
            <button
              onClick={savePaymentSettings}
              disabled={saving}
              className="mt-3 px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>

        {/* Book Direct Benefits */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Book Direct Benefits</h2>
          <p className="text-xs text-gray-500 mb-4">These appear in the room detail modal, encouraging guests to book via your website instead of OTAs. Benefits apply to all rooms.</p>

          <div className="space-y-2 mb-4">
            {BENEFIT_OPTIONS.map((benefit) => {
              const isSelected = benefits.includes(benefit)
              return (
                <button
                  key={benefit}
                  type="button"
                  onClick={() => {
                    if (isSelected) {
                      setBenefits(benefits.filter((b) => b !== benefit))
                    } else {
                      setBenefits([...benefits, benefit])
                    }
                  }}
                  className={`w-full flex items-center gap-3 px-4 py-2 rounded-lg border text-left transition-colors ${
                    isSelected
                      ? 'border-primary-300 bg-primary-50/30'
                      : 'border-gray-200 bg-gray-50 hover:bg-gray-100'
                  }`}
                >
                  <div className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 flex items-center justify-center ${
                    isSelected ? 'border-primary-500 bg-primary-500' : 'border-gray-300'
                  }`}>
                    {isSelected && (
                      <CheckIcon className="w-2 h-2 text-white" />
                    )}
                  </div>
                  <span className="text-[12px] text-gray-700">{benefit}</span>
                </button>
              )
            })}
          </div>

          {/* Custom benefit input */}
          <div className="mb-4">
            <label className="block text-[11px] text-gray-500 mb-1.5">Custom Benefit <span className="text-gray-400">(optional)</span></label>
            <div className="flex gap-2">
              <input
                type="text"
                value={benefitInput}
                onChange={(e) => setBenefitInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    const trimmed = benefitInput.trim()
                    if (trimmed && !benefits.includes(trimmed)) {
                      setBenefits([...benefits, trimmed])
                    }
                    setBenefitInput('')
                  }
                }}
                className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                placeholder="e.g. Complimentary sunset cocktail"
              />
              <button
                type="button"
                onClick={() => {
                  const trimmed = benefitInput.trim()
                  if (trimmed && !benefits.includes(trimmed)) {
                    setBenefits([...benefits, trimmed])
                  }
                  setBenefitInput('')
                }}
                className="px-3 py-2 border border-gray-200 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
              >
                <PlusIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Selected custom benefits */}
          {benefits.filter(b => !BENEFIT_OPTIONS.includes(b)).length > 0 && (
            <div className="mb-4 space-y-1">
              <span className="text-[10px] text-gray-400 uppercase tracking-wider">Custom benefits</span>
              <div className="flex flex-wrap gap-2">
                {benefits.filter(b => !BENEFIT_OPTIONS.includes(b)).map((b, i) => (
                  <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 bg-primary-50 text-primary-700 text-[11px] font-medium rounded-full border border-primary-200">
                    {b}
                    <button type="button" onClick={() => setBenefits(benefits.filter(x => x !== b))} className="text-primary-400 hover:text-primary-600">
                      <XMarkIcon className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={saveBenefits}
            disabled={savingBenefits}
            className="px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            {savingBenefits ? 'Saving...' : 'Save Benefits'}
          </button>
        </div>

      </div>
    </div>
  )
}
