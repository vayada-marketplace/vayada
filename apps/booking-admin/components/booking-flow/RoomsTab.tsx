'use client'

import { ToggleSwitch } from '@/components/ui'
import { AVAILABLE_FILTERS } from '@/lib/constants/filters'

interface RoomsTabProps {
  bookingFilters: string[]
  handleToggleFilter: (key: string) => void
  handleSaveFilters: () => void
  savingFilters: boolean
}

function RoomsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7v11a2 2 0 002 2h14a2 2 0 002-2V7" />
      <path d="M6 7V5a2 2 0 012-2h8a2 2 0 012 2v2" />
      <path d="M3 7h18" />
      <path d="M8 11h8" />
    </svg>
  )
}

export default function RoomsTab({
  bookingFilters,
  handleToggleFilter,
  handleSaveFilters,
  savingFilters,
}: RoomsTabProps) {
  return (
    <div className="max-w-2xl space-y-4">
      {/* Room Visual Merchandising */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h2 className="text-[14px] font-semibold text-gray-900">Room Visual Merchandising</h2>
        <p className="text-[12px] text-gray-500 mt-0.5 mb-4">Rooms are synced from your PMS. Manage room types, images, and pricing in the Property Manager.</p>

        <div className="bg-gray-50 rounded-lg border border-gray-200 p-4 text-center">
          <div className="w-10 h-10 bg-gray-200 rounded-full mx-auto flex items-center justify-center mb-2">
            <RoomsIcon className="w-5 h-5 text-gray-400" />
          </div>
          <p className="text-[13px] font-medium text-gray-600">Rooms are managed in your PMS</p>
          <p className="text-[12px] text-gray-400 mt-0.5">Room types, images, and pricing sync automatically</p>
        </div>
      </div>

      {/* Popular Filters */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h2 className="text-[14px] font-semibold text-gray-900">Popular Filters</h2>
        <p className="text-[12px] text-gray-500 mt-0.5 mb-4">Choose which filters guests can use to narrow room results</p>

        <div className="grid grid-cols-2 gap-2">
          {AVAILABLE_FILTERS.map((filter) => (
            <ToggleSwitch
              key={filter.key}
              size="sm"
              enabled={bookingFilters.includes(filter.key)}
              onChange={() => handleToggleFilter(filter.key)}
              label={filter.label}
            />
          ))}
        </div>

        <button
          onClick={handleSaveFilters}
          disabled={savingFilters}
          className="mt-4 inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-primary-500 text-white text-[13px] font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors"
        >
          {savingFilters ? (
            <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : null}
          Save Filters
        </button>
      </div>
    </div>
  )
}
