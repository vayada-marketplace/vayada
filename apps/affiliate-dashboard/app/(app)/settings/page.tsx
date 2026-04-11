'use client'

import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { apiClient } from '@/services/api/client'
import { authService } from '@/services/auth'

interface Property {
  affiliateId: string
  hotelName: string
  paymentMethod: string
  paypalEmail: string
  bankIban: string
  bankAccountHolder: string
  bankSwiftBic: string
  bankName: string
  bankCountry: string
  xenditChannelCode: string | null
  xenditAccountNumber: string | null
  xenditAccountHolderName: string | null
  stripeConnectOnboarded: boolean
}

const XENDIT_BANKS = [
  { code: 'ID_BCA', name: 'BCA' },
  { code: 'ID_MANDIRI', name: 'Mandiri' },
  { code: 'ID_BNI', name: 'BNI' },
  { code: 'ID_BRI', name: 'BRI' },
  { code: 'ID_PERMATA', name: 'Permata' },
  { code: 'ID_CIMB', name: 'CIMB Niaga' },
]

export default function SettingsPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [validating, setValidating] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [paymentMethod, setPaymentMethod] = useState('stripe')
  const [paypalEmail, setPaypalEmail] = useState('')
  const [bankIban, setBankIban] = useState('')
  const [bankAccountHolder, setBankAccountHolder] = useState('')
  const [bankSwiftBic, setBankSwiftBic] = useState('')
  const [bankName, setBankName] = useState('')
  const [bankCountry, setBankCountry] = useState('')
  const [xenditChannelCode, setXenditChannelCode] = useState('ID_BCA')
  const [xenditAccountNumber, setXenditAccountNumber] = useState('')
  const [xenditAccountHolderName, setXenditAccountHolderName] = useState('')

  const userName = authService.getUserName()
  const userInitials = authService.getUserInitials()

  useEffect(() => {
    apiClient.get<{ properties: Property[] }>('/affiliate/properties')
      .then((res) => {
        const first = res.properties?.[0]
        if (first) {
          setPaymentMethod(first.paymentMethod || 'stripe')
          setPaypalEmail(first.paypalEmail || '')
          setBankIban(first.bankIban || '')
          setBankAccountHolder(first.bankAccountHolder || '')
          setBankSwiftBic(first.bankSwiftBic || '')
          setBankName(first.bankName || '')
          setBankCountry(first.bankCountry || '')
          setXenditChannelCode(first.xenditChannelCode || 'ID_BCA')
          setXenditAccountNumber(first.xenditAccountNumber || '')
          setXenditAccountHolderName(first.xenditAccountHolderName || '')
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const handleValidateBank = async () => {
    setError('')
    setSuccess('')
    if (!xenditAccountNumber.trim() || !/^\d{5,20}$/.test(xenditAccountNumber.trim())) {
      setError('Enter a valid account number (5-20 digits) first')
      return
    }
    setValidating(true)
    try {
      const res = await apiClient.post<{ account_holder: string }>('/affiliate/xendit/validate-bank-account', {
        channelCode: xenditChannelCode,
        accountNumber: xenditAccountNumber.trim(),
      })
      if (res.account_holder) {
        setXenditAccountHolderName(res.account_holder)
        setSuccess(`Account verified — holder: ${res.account_holder}`)
      } else {
        setSuccess('Account validated successfully')
      }
    } catch (err: any) {
      setError(err.message || 'Bank account validation failed')
    } finally {
      setValidating(false)
    }
  }

  const handleSave = async () => {
    setError('')
    setSuccess('')

    if (paymentMethod === 'xendit') {
      if (!xenditAccountNumber.trim()) {
        setError('Account number is required')
        return
      }
      if (!/^\d{5,20}$/.test(xenditAccountNumber.trim())) {
        setError('Account number must be 5-20 digits')
        return
      }
      if (!xenditAccountHolderName.trim()) {
        setError('Account holder name is required')
        return
      }
    }
    if (paymentMethod === 'paypal' && !paypalEmail.trim()) {
      setError('PayPal email is required')
      return
    }
    if (paymentMethod === 'bank') {
      if (!bankAccountHolder.trim()) { setError('Account holder name is required'); return }
      if (!bankIban.trim()) { setError('IBAN / account number is required'); return }
      if (!bankSwiftBic.trim()) { setError('SWIFT / BIC is required'); return }
      if (!bankName.trim()) { setError('Bank name is required'); return }
      if (!bankCountry.trim()) { setError('Bank country is required'); return }
    }

    setSaving(true)
    try {
      await apiClient.patch('/affiliate/me', {
        paymentMethod,
        ...(paymentMethod === 'paypal' ? { paypalEmail } : {}),
        ...(paymentMethod === 'bank' ? {
          bankIban: bankIban.trim().toUpperCase(),
          bankAccountHolder: bankAccountHolder.trim(),
          bankSwiftBic: bankSwiftBic.trim().toUpperCase(),
          bankName: bankName.trim(),
          bankCountry: bankCountry.trim().toUpperCase(),
        } : {}),
        ...(paymentMethod === 'xendit' ? {
          xenditChannelCode,
          xenditAccountNumber: xenditAccountNumber.trim(),
          xenditAccountHolderName: xenditAccountHolderName.trim(),
        } : {}),
      })
      setSuccess('Payment settings saved')
    } catch (err: any) {
      setError(err.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <div className="text-gray-500 text-sm">Loading settings...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <Navbar userName={userName} userInitials={userInitials} />

      <main className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="text-sm text-gray-500 mt-1">Manage your payout preferences</p>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Payout Method</h2>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
              {error}
            </div>
          )}
          {success && (
            <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg">
              {success}
            </div>
          )}

          <div className="space-y-4">
            {/* Payment method selector */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(['stripe', 'xendit', 'paypal', 'bank'] as const).map((method) => (
                <button
                  key={method}
                  onClick={() => { setPaymentMethod(method); setError(''); setSuccess('') }}
                  className={`px-3 py-2 text-sm rounded-lg border font-medium transition-colors ${
                    paymentMethod === method
                      ? 'border-primary-600 bg-primary-50 text-primary-700'
                      : 'border-gray-200 text-gray-600 hover:border-gray-300'
                  }`}
                >
                  {method === 'stripe' ? 'Stripe' : method === 'xendit' ? 'Xendit' : method === 'paypal' ? 'PayPal' : 'Bank Transfer'}
                </button>
              ))}
            </div>

            {/* Xendit fields */}
            {paymentMethod === 'xendit' && (
              <div className="space-y-3 pt-2">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Bank</label>
                  <select
                    value={xenditChannelCode}
                    onChange={(e) => setXenditChannelCode(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    {XENDIT_BANKS.map((bank) => (
                      <option key={bank.code} value={bank.code}>{bank.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Account Number</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={20}
                    value={xenditAccountNumber}
                    onChange={(e) => setXenditAccountNumber(e.target.value.replace(/\D/g, ''))}
                    placeholder="1234567890"
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
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
                <button
                  type="button"
                  onClick={handleValidateBank}
                  disabled={validating || !xenditAccountNumber.trim()}
                  className="w-full px-4 py-2 text-sm font-medium text-primary-700 bg-primary-50 border border-primary-200 rounded-lg hover:bg-primary-100 disabled:opacity-50 transition-colors"
                >
                  {validating ? 'Validating...' : 'Validate Bank Account'}
                </button>
              </div>
            )}

            {/* PayPal fields */}
            {paymentMethod === 'paypal' && (
              <div className="pt-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">PayPal Email</label>
                <input
                  type="email"
                  value={paypalEmail}
                  onChange={(e) => setPaypalEmail(e.target.value)}
                  placeholder="your@email.com"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
            )}

            {/* Bank fields */}
            {paymentMethod === 'bank' && (
              <div className="space-y-3 pt-2">
                <p className="text-xs text-gray-500">
                  International transfers need these details. Make sure they match your bank records exactly.
                </p>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Account Holder Name</label>
                  <input
                    type="text"
                    value={bankAccountHolder}
                    onChange={(e) => setBankAccountHolder(e.target.value)}
                    placeholder="Full name as on bank account"
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">IBAN / Account Number</label>
                  <input
                    type="text"
                    value={bankIban}
                    onChange={(e) => setBankIban(e.target.value.toUpperCase())}
                    placeholder="AT89 3704 0044 0532 0130 00"
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">SWIFT / BIC</label>
                    <input
                      type="text"
                      value={bankSwiftBic}
                      onChange={(e) => setBankSwiftBic(e.target.value.toUpperCase())}
                      placeholder="DEUTDEFF"
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Country</label>
                    <input
                      type="text"
                      value={bankCountry}
                      onChange={(e) => setBankCountry(e.target.value.toUpperCase().slice(0, 2))}
                      placeholder="DE"
                      maxLength={2}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg font-mono uppercase focus:outline-none focus:ring-2 focus:ring-primary-500"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Bank Name</label>
                  <input
                    type="text"
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value)}
                    placeholder="Deutsche Bank"
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
              </div>
            )}

            {/* Stripe info */}
            {paymentMethod === 'stripe' && (
              <p className="text-xs text-gray-500 pt-2">
                Stripe Connect payouts are managed by the property. Contact the property admin if you need to update your Stripe details.
              </p>
            )}

            <button
              onClick={handleSave}
              disabled={saving}
              className="w-full mt-2 px-4 py-2.5 text-sm font-medium text-white bg-primary-800 rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : 'Save Payout Settings'}
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}
