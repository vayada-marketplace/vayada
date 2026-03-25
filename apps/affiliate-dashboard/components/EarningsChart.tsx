'use client'

import { useState } from 'react'

interface MonthData {
  month: string
  earnings: number
}

const data: MonthData[] = [
  { month: 'Oct', earnings: 120 },
  { month: 'Nov', earnings: 340 },
  { month: 'Dec', earnings: 480 },
  { month: 'Jan', earnings: 260 },
  { month: 'Feb', earnings: 520 },
  { month: 'Mar', earnings: 920 },
]

type Period = '6m' | '3m' | '1m'

export default function EarningsChart() {
  const [period, setPeriod] = useState<Period>('6m')
  const maxEarnings = Math.max(...data.map((d) => d.earnings))

  const filteredData =
    period === '1m' ? data.slice(-1) : period === '3m' ? data.slice(-3) : data

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

      <div className="flex items-end gap-3 h-40">
        {filteredData.map((d) => (
          <div key={d.month} className="flex-1 flex flex-col items-center gap-1.5">
            <span className="text-xs font-medium text-gray-700">
              ${d.earnings}
            </span>
            <div
              className="w-full bg-primary-500 rounded-t-md transition-all duration-300 min-h-[4px]"
              style={{ height: `${(d.earnings / maxEarnings) * 100}%` }}
            />
            <span className="text-xs text-muted">{d.month}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
