'use client'

import { useState } from 'react'
import useSWR from 'swr'
import DataState from '@/components/DataState'
import { currencySymbol } from '@/services/constants/currency'
import type { EarningsPeriod, EarningsResponse } from '@/services/types'

type Period = Extract<EarningsPeriod, '6m' | '3m' | '1m'>

const MESSAGE_CLASSNAME = 'h-40 flex items-center justify-center text-sm text-muted'

export default function EarningsChart() {
  const [period, setPeriod] = useState<Period>('6m')
  const { data: response, error } = useSWR<EarningsResponse>(`/affiliate/earnings?period=${period}`)

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

      <DataState
        data={response ?? null}
        error={Boolean(error)}
        isEmpty={(r) => r.months.length === 0}
        loadingLabel="Loading…"
        errorLabel="Couldn't load earnings."
        emptyLabel="No earnings yet."
        loadingClassName={MESSAGE_CLASSNAME}
        errorClassName={MESSAGE_CLASSNAME}
        emptyClassName={MESSAGE_CLASSNAME}
      >
        {(res) => {
          const maxEarnings = Math.max(...res.months.map((d) => d.earnings), 1)
          const symbol = currencySymbol(res.currency)
          return (
            <div className="flex items-end gap-3 h-40">
              {res.months.map((d) => (
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
          )
        }}
      </DataState>
    </div>
  )
}
