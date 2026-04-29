'use client'

import { useEffect, useState } from 'react'
import { apiClient } from '@/services/api/client'

interface MonthData {
  month: string
  label: string
  earnings: number
}

interface EarningsResponse {
  months: MonthData[]
  currency: string
}

type Period = '6m' | '3m' | '1m'

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€',
  USD: '$',
  GBP: '£',
  IDR: 'Rp',
}

export default function EarningsChart() {
  const [period, setPeriod] = useState<Period>('6m')
  const [data, setData] = useState<MonthData[]>([])
  const [currency, setCurrency] = useState('EUR')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    apiClient
      .get<EarningsResponse>(`/affiliate/earnings?period=${period}`)
      .then((res) => {
        if (cancelled) return
        setData(res.months)
        setCurrency(res.currency)
      })
      .catch(() => {
        if (cancelled) return
        setError(true)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [period])

  const maxEarnings = data.length > 0 ? Math.max(...data.map((d) => d.earnings), 1) : 1
  const symbol = CURRENCY_SYMBOLS[currency] || currency + ' '

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-5">
        <h3 className="font-semibold text-gray-900">Earnings Over Time</h3>
        <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
          {(['6m', '3m', '1m'] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                period === p
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-muted hover:text-gray-700'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="h-40 flex items-center justify-center text-sm text-muted">
          Loading…
        </div>
      )}

      {!loading && error && (
        <div className="h-40 flex items-center justify-center text-sm text-muted">
          Couldn&apos;t load earnings.
        </div>
      )}

      {!loading && !error && data.length > 0 && (
        <div className="flex items-end gap-3 h-40">
          {data.map((d) => (
            <div key={d.month} className="flex-1 flex flex-col items-center gap-1.5">
              <span className="text-xs font-medium text-gray-700">
                {symbol}
                {Math.round(d.earnings).toLocaleString()}
              </span>
              <div
                className="w-full bg-primary-500 rounded-t-md transition-all duration-300 min-h-[4px]"
                style={{ height: `${(d.earnings / maxEarnings) * 100}%` }}
              />
              <span className="text-xs text-muted">{d.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
