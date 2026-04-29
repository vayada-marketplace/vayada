'use client'

import { useEffect, useState } from 'react'
import { CheckCircleIcon } from '@heroicons/react/24/solid'
import { apiClient } from '@/services/api/client'
import DataState from '@/components/DataState'

interface Payout {
  id: string
  date: string
  amount: number
  currency: string
  method: string
  reference: string | null
  bookingCount: number
  status: string
}

const METHOD_LABELS: Record<string, string> = {
  bank: 'Bank Transfer',
  paypal: 'PayPal',
  stripe: 'Stripe',
  xendit: 'Xendit',
  manual: 'Manual',
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
  } catch {
    return `${currency} ${amount.toLocaleString()}`
  }
}

export default function PayoutHistory() {
  const [payouts, setPayouts] = useState<Payout[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    apiClient
      .get<{ payouts: Payout[] }>('/affiliate/payouts')
      .then((res) => setPayouts(res.payouts))
      .catch(() => setError(true))
  }, [])

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-gray-900">Payout History</h3>
        <a href="#" className="text-sm text-primary-600 hover:text-primary-700 font-medium">
          View all
        </a>
      </div>

      <DataState
        data={payouts}
        error={error}
        isEmpty={(p) => p.length === 0}
        loadingLabel="Loading payouts…"
        errorLabel="Couldn't load payouts."
        emptyLabel="No payouts yet."
      >
        {(items) => (
          <div className="space-y-3">
            {items.map((payout) => (
              <div
                key={payout.id}
                className="flex items-center justify-between py-2.5 border-b border-gray-100 last:border-0"
              >
                <div className="flex items-center gap-3">
                  <CheckCircleIcon className="w-5 h-5 text-success-500" />
                  <div>
                    <p className="text-sm font-medium text-gray-900">
                      {formatAmount(payout.amount, payout.currency)}
                    </p>
                    <p className="text-xs text-muted">
                      {formatDate(payout.date)} &middot; {METHOD_LABELS[payout.method] || payout.method}
                    </p>
                  </div>
                </div>
                <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-success-50 text-success-700">
                  Paid
                </span>
              </div>
            ))}
          </div>
        )}
      </DataState>
    </div>
  )
}
