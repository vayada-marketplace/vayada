'use client'

import { useEffect, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import useSWR from 'swr'
import { ExclamationTriangleIcon, InformationCircleIcon } from '@heroicons/react/24/outline'
import Navbar from '@/components/Navbar'
import { apiClient, extractErrorMessage } from '@/services/api/client'
import { authService } from '@/services/auth'
import {
  DEFAULT_SETTINGS,
  PAYMENT_METHODS,
  PaymentMethod,
  SettingsFormValues,
  XENDIT_BANKS,
  settingsSchema,
} from '@/services/schemas/settings'
import type { AffiliateProperty, PropertiesResponse } from '@/services/types'

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  stripe: 'Stripe',
  xendit: 'Xendit',
  paypal: 'PayPal',
  bank: 'Bank Transfer',
}

function settingsFromProperty(p: AffiliateProperty): SettingsFormValues {
  return {
    paymentMethod: (PAYMENT_METHODS as readonly string[]).includes(p.paymentMethod)
      ? (p.paymentMethod as PaymentMethod)
      : 'stripe',
    paypalEmail: p.paypalEmail || '',
    bankIban: p.bankIban || '',
    bankAccountHolder: p.bankAccountHolder || '',
    bankSwiftBic: p.bankSwiftBic || '',
    bankName: p.bankName || '',
    bankCountry: p.bankCountry || '',
    xenditChannelCode: p.xenditChannelCode || 'ID_BCA',
    xenditAccountNumber: p.xenditAccountNumber || '',
    xenditAccountHolderName: p.xenditAccountHolderName || '',
  }
}

function propertiesDiffer(properties: AffiliateProperty[]): boolean {
  if (properties.length < 2) return false
  const first = JSON.stringify(settingsFromProperty(properties[0]))
  return properties.slice(1).some((p) => JSON.stringify(settingsFromProperty(p)) !== first)
}

export default function SettingsPage() {
  const { data, error: loadError } = useSWR<PropertiesResponse>('/affiliate/properties')

  const [saving, setSaving] = useState(false)
  const [validating, setValidating] = useState(false)
  const [topError, setTopError] = useState('')
  const [success, setSuccess] = useState('')

  const userName = authService.getUserName()
  const userInitials = authService.getUserInitials()

  const {
    register,
    handleSubmit,
    control,
    reset,
    setValue,
    getValues,
    trigger,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: DEFAULT_SETTINGS,
  })

  const paymentMethod = watch('paymentMethod')
  const properties = data?.properties ?? []
  const drift = propertiesDiffer(properties)

  useEffect(() => {
    const first = data?.properties?.[0]
    if (first) reset(settingsFromProperty(first))
  }, [data, reset])

  const handleValidateBank = async () => {
    setTopError('')
    setSuccess('')
    const ok = await trigger('xenditAccountNumber')
    if (!ok) return
    const values = getValues()
    setValidating(true)
    try {
      const res = await apiClient.post<{ account_holder: string }>(
        '/affiliate/xendit/validate-bank-account',
        {
          channelCode: values.xenditChannelCode,
          accountNumber: values.xenditAccountNumber.trim(),
        },
      )
      if (res.account_holder) {
        setValue('xenditAccountHolderName', res.account_holder, { shouldDirty: true })
        setSuccess(`Account verified — holder: ${res.account_holder}`)
      } else {
        setSuccess('Account validated successfully')
      }
    } catch (err) {
      setTopError(extractErrorMessage(err, 'Bank account validation failed'))
    } finally {
      setValidating(false)
    }
  }

  const onSubmit = async (values: SettingsFormValues) => {
    setTopError('')
    setSuccess('')
    setSaving(true)
    try {
      await apiClient.patch('/affiliate/me', {
        paymentMethod: values.paymentMethod,
        ...(values.paymentMethod === 'paypal' && { paypalEmail: values.paypalEmail.trim() }),
        ...(values.paymentMethod === 'bank' && {
          bankIban: values.bankIban.trim().toUpperCase(),
          bankAccountHolder: values.bankAccountHolder.trim(),
          bankSwiftBic: values.bankSwiftBic.trim().toUpperCase(),
          bankName: values.bankName.trim(),
          bankCountry: values.bankCountry.trim().toUpperCase(),
        }),
        ...(values.paymentMethod === 'xendit' && {
          xenditChannelCode: values.xenditChannelCode,
          xenditAccountNumber: values.xenditAccountNumber.trim(),
          xenditAccountHolderName: values.xenditAccountHolderName.trim(),
        }),
      })
      setSuccess('Payment settings saved')
    } catch (err) {
      setTopError(extractErrorMessage(err, 'Failed to save'))
    } finally {
      setSaving(false)
    }
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <div className="text-red-600 text-sm">Failed to load settings.</div>
      </div>
    )
  }

  if (!data) {
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

        {properties.length > 1 && !drift && (
          <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-start gap-2">
            <InformationCircleIcon className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-blue-800">
              These payout settings apply to all {properties.length} of your properties.
            </p>
          </div>
        )}

        {drift && (
          <div className="mb-4 p-3 bg-warning-50 border border-warning-200 rounded-lg flex items-start gap-2">
            <ExclamationTriangleIcon className="w-4 h-4 text-warning-700 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-warning-800">
              Your properties currently have different payout settings. Showing the
              configuration from <strong>{properties[0].hotelName}</strong>. Saving will
              overwrite the others.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit)} className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Payout Method</h2>

          {topError && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
              {topError}
            </div>
          )}
          {success && (
            <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg">
              {success}
            </div>
          )}

          <div className="space-y-4">
            <Controller
              control={control}
              name="paymentMethod"
              render={({ field }) => (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {PAYMENT_METHODS.map((method) => (
                    <button
                      key={method}
                      type="button"
                      onClick={() => {
                        field.onChange(method)
                        setTopError('')
                        setSuccess('')
                      }}
                      className={`px-3 py-2 text-sm rounded-lg border font-medium transition-colors ${
                        field.value === method
                          ? 'border-primary-600 bg-primary-50 text-primary-700'
                          : 'border-gray-200 text-gray-600 hover:border-gray-300'
                      }`}
                    >
                      {PAYMENT_METHOD_LABELS[method]}
                    </button>
                  ))}
                </div>
              )}
            />

            {paymentMethod === 'xendit' && (
              <div className="space-y-3 pt-2">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Bank</label>
                  <select
                    {...register('xenditChannelCode')}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    {XENDIT_BANKS.map((bank) => (
                      <option key={bank.code} value={bank.code}>{bank.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Account Number</label>
                  <Controller
                    control={control}
                    name="xenditAccountNumber"
                    render={({ field }) => (
                      <input
                        {...field}
                        type="text"
                        inputMode="numeric"
                        maxLength={20}
                        onChange={(e) => field.onChange(e.target.value.replace(/\D/g, ''))}
                        placeholder="1234567890"
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                    )}
                  />
                  {errors.xenditAccountNumber && (
                    <p className="mt-1 text-xs text-red-600">{errors.xenditAccountNumber.message}</p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Account Holder Name</label>
                  <input
                    {...register('xenditAccountHolderName')}
                    type="text"
                    placeholder="Full name as on bank account"
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  {errors.xenditAccountHolderName && (
                    <p className="mt-1 text-xs text-red-600">{errors.xenditAccountHolderName.message}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleValidateBank}
                  disabled={validating || !watch('xenditAccountNumber').trim()}
                  className="w-full px-4 py-2 text-sm font-medium text-primary-700 bg-primary-50 border border-primary-200 rounded-lg hover:bg-primary-100 disabled:opacity-50 transition-colors"
                >
                  {validating ? 'Validating...' : 'Validate Bank Account'}
                </button>
              </div>
            )}

            {paymentMethod === 'paypal' && (
              <div className="pt-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">PayPal Email</label>
                <input
                  {...register('paypalEmail')}
                  type="email"
                  placeholder="your@email.com"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
                {errors.paypalEmail && (
                  <p className="mt-1 text-xs text-red-600">{errors.paypalEmail.message}</p>
                )}
              </div>
            )}

            {paymentMethod === 'bank' && (
              <div className="space-y-3 pt-2">
                <p className="text-xs text-gray-500">
                  International transfers need these details. Make sure they match your bank records exactly.
                </p>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Account Holder Name</label>
                  <input
                    {...register('bankAccountHolder')}
                    type="text"
                    placeholder="Full name as on bank account"
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  {errors.bankAccountHolder && (
                    <p className="mt-1 text-xs text-red-600">{errors.bankAccountHolder.message}</p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">IBAN / Account Number</label>
                  <Controller
                    control={control}
                    name="bankIban"
                    render={({ field }) => (
                      <input
                        {...field}
                        type="text"
                        onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                        placeholder="AT89 3704 0044 0532 0130 00"
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                    )}
                  />
                  {errors.bankIban && (
                    <p className="mt-1 text-xs text-red-600">{errors.bankIban.message}</p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">SWIFT / BIC</label>
                    <Controller
                      control={control}
                      name="bankSwiftBic"
                      render={({ field }) => (
                        <input
                          {...field}
                          type="text"
                          onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                          placeholder="DEUTDEFF"
                          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      )}
                    />
                    {errors.bankSwiftBic && (
                      <p className="mt-1 text-xs text-red-600">{errors.bankSwiftBic.message}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Country</label>
                    <Controller
                      control={control}
                      name="bankCountry"
                      render={({ field }) => (
                        <input
                          {...field}
                          type="text"
                          maxLength={2}
                          onChange={(e) => field.onChange(e.target.value.toUpperCase().slice(0, 2))}
                          placeholder="DE"
                          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg font-mono uppercase focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      )}
                    />
                    {errors.bankCountry && (
                      <p className="mt-1 text-xs text-red-600">{errors.bankCountry.message}</p>
                    )}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Bank Name</label>
                  <input
                    {...register('bankName')}
                    type="text"
                    placeholder="Deutsche Bank"
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  {errors.bankName && (
                    <p className="mt-1 text-xs text-red-600">{errors.bankName.message}</p>
                  )}
                </div>
              </div>
            )}

            {paymentMethod === 'stripe' && (
              <p className="text-xs text-gray-500 pt-2">
                Stripe Connect payouts are managed by the property. Contact the property admin if you need to update your Stripe details.
              </p>
            )}

            <button
              type="submit"
              disabled={saving || isSubmitting}
              className="w-full mt-2 px-4 py-2.5 text-sm font-medium text-white bg-primary-800 rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : 'Save Payout Settings'}
            </button>
          </div>
        </form>
      </main>
    </div>
  )
}
