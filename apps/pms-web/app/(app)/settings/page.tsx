'use client'

import { useState, useEffect } from 'react'
import { bookingsService, PaymentSettings, CancellationPolicy } from '@/services/bookings'

export default function SettingsPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')

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

  // Cancellation policy
  const [freeDays, setFreeDays] = useState(7)
  const [partialRefundPct, setPartialRefundPct] = useState(0)

  useEffect(() => {
    bookingsService.getPaymentSettings()
      .then((res) => {
        const ps = res.paymentSettings
        setFeeType(ps.platformFeeType)
        setFeeValue(ps.platformFeeValue)
        setFeeWithAffiliate(ps.platformFeeWithAffiliate)
        setPayAtProperty(ps.payAtPropertyEnabled)
        setStripeAccountId(ps.stripeConnectAccountId)
        setStripeOnboarded(ps.stripeConnectOnboarded)

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
