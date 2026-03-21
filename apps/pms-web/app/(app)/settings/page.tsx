'use client'

import { useState, useEffect } from 'react'
import { bookingsService, PaymentSettings, CancellationPolicy } from '@/services/bookings'
import { customDomainService, CustomDomainStatus } from '@/services/custom-domain'

export default function SettingsPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')

  // Custom domain
  const [domainInput, setDomainInput] = useState('')
  const [domainStatus, setDomainStatus] = useState<CustomDomainStatus | null>(null)
  const [domainLoading, setDomainLoading] = useState(false)

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

  useEffect(() => {
    customDomainService.getStatus()
      .then(setDomainStatus)
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
      await customDomainService.connect(domainInput.trim().toLowerCase())
      const status = await customDomainService.getStatus()
      setDomainStatus(status)
      setDomainInput('')
      setSuccess('Custom domain connected. Please add the DNS record below.')
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

        {/* Stripe Connect */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Stripe Connect</h2>
          {stripeAccountId ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${stripeOnboarded ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                  {stripeOnboarded ? 'Connected' : 'Pending Onboarding'}
                </span>
                <span className="text-xs text-gray-500 font-mono">{stripeAccountId}</span>
              </div>
              {!stripeOnboarded && (
                <button
                  onClick={handleOnboarding}
                  className="px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
                >
                  Complete Onboarding
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-gray-600">Connect your Stripe account to receive payouts.</p>
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
                  </select>
                </div>
              </div>
              <button
                onClick={handleCreateStripeAccount}
                disabled={creatingAccount || !connectEmail}
                className="px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
              >
                {creatingAccount ? 'Creating...' : 'Connect Stripe Account'}
              </button>
            </div>
          )}
        </div>

        {/* Payment Provider */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Payout Provider</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-2">Provider for hotel payouts</label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={paymentProvider === 'stripe'}
                    onChange={() => setPaymentProvider('stripe')}
                    className="text-primary-600"
                  />
                  <span className="text-sm text-gray-700">Stripe</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={paymentProvider === 'xendit'}
                    onChange={() => setPaymentProvider('xendit')}
                    className="text-primary-600"
                  />
                  <span className="text-sm text-gray-700">Xendit (Indonesia)</span>
                </label>
              </div>
            </div>

            {paymentProvider === 'xendit' && (
              <div className="space-y-3 pt-2 border-t border-gray-100">
                <p className="text-sm text-gray-500">Enter your Indonesian bank account details for Xendit payouts.</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Bank Channel</label>
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
            )}
          </div>
        </div>

        {/* Platform Fee Settings */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Platform Fee</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-2">Fee Model</label>
              <div className="flex gap-3">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={feeType === 'percentage'}
                    onChange={() => setFeeType('percentage')}
                    className="text-primary-600"
                  />
                  <span className="text-sm text-gray-700">Percentage</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={feeType === 'flat'}
                    onChange={() => setFeeType('flat')}
                    className="text-primary-600"
                  />
                  <span className="text-sm text-gray-700">Flat Amount</span>
                </label>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Standard Fee {feeType === 'percentage' ? '(%)' : '(EUR)'}
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={feeValue}
                  onChange={(e) => setFeeValue(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Fee with Affiliate {feeType === 'percentage' ? '(%)' : '(EUR)'}
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={feeWithAffiliate}
                  onChange={(e) => setFeeWithAffiliate(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={payAtProperty}
                onChange={(e) => setPayAtProperty(e.target.checked)}
                className="rounded text-primary-600"
              />
              <label className="text-sm text-gray-700">Enable &quot;Pay at Property&quot; option for guests</label>
            </div>

            <button
              onClick={savePaymentSettings}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : 'Save Payment Settings'}
            </button>
          </div>
        </div>

        {/* Cancellation Policy */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Cancellation Policy</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Free cancellation window (days before check-in)
              </label>
              <input
                type="number"
                value={freeDays}
                onChange={(e) => setFreeDays(Number(e.target.value))}
                min={0}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 max-w-xs"
              />
              <p className="text-xs text-gray-500 mt-1">
                Guests can cancel for free up to {freeDays} days before check-in.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Partial refund after free window (%)
              </label>
              <input
                type="number"
                step="1"
                value={partialRefundPct}
                onChange={(e) => setPartialRefundPct(Number(e.target.value))}
                min={0}
                max={100}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 max-w-xs"
              />
              <p className="text-xs text-gray-500 mt-1">
                {partialRefundPct > 0
                  ? `After the free window, guests receive a ${partialRefundPct}% refund.`
                  : 'After the free window, no refund is given.'}
              </p>
            </div>

            <button
              onClick={saveCancellationPolicy}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : 'Save Cancellation Policy'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
