'use client'

import { useState } from 'react'
import { XMarkIcon, PlusIcon } from '@heroicons/react/24/outline'
import { AVAILABLE_FILTERS } from '@/lib/constants/filters'

interface RoomsTabProps {
  bookingFilters: string[]
  setBookingFilters: (v: string[] | ((prev: string[]) => string[])) => void
  customFilters: Record<string, string>
  setCustomFilters: (v: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>)) => void
  filtersEnabled: boolean
  onToggleFiltersEnabled: () => void
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
  setBookingFilters,
  customFilters,
  setCustomFilters,
  filtersEnabled,
  onToggleFiltersEnabled,
  handleSaveFilters,
  savingFilters,
}: RoomsTabProps) {
  const [newFilterLabel, setNewFilterLabel] = useState('')

  const addCustomFilter = () => {
    if (!newFilterLabel.trim()) return
    const label = newFilterLabel.trim()
    const key = label
      .split(/\s+/)
      .map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join('')
    if (!AVAILABLE_FILTERS.some((f) => f.key === key) && !customFilters[key]) {
      setCustomFilters((prev: Record<string, string>) => ({ ...prev, [key]: label }))
      setBookingFilters((prev: string[]) => [...prev, key])
    }
    setNewFilterLabel('')
  }

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

      {/* Room Filters */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <div className="flex items-start justify-between mb-1">
          <div>
            <h2 className="text-[14px] font-semibold text-gray-900">Room Filters</h2>
            <p className="text-[12px] text-gray-500 mt-0.5">Choose which filters guests can use to narrow room results</p>
          </div>
          <button
            type="button"
            onClick={onToggleFiltersEnabled}
            className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 mt-0.5 ${
              filtersEnabled ? 'bg-primary-500' : 'bg-gray-300'
            }`}
          >
            <span className={`absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow transition-transform ${
              filtersEnabled ? 'translate-x-[18px]' : ''
            }`} />
          </button>
        </div>

        {filtersEnabled && (
          <div className="mt-4">
            <div className="space-y-2">
              {[
                ...AVAILABLE_FILTERS.map((f) => ({ ...f, isCustom: false as const })),
                ...Object.entries(customFilters).map(([key, label]) => ({ key, label, isCustom: true as const })),
              ].map((filter) => {
                const enabled = bookingFilters.includes(filter.key)
                return (
                  <div
                    key={filter.key}
                    className={`w-full flex items-center justify-between p-3 rounded-lg border transition-all ${
                      enabled
                        ? 'border-primary-500 bg-primary-50/30'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <button
                      className="flex-1 text-left"
                      onClick={() => {
                        setBookingFilters((prev: string[]) =>
                          enabled
                            ? prev.filter((k) => k !== filter.key)
                            : [...prev, filter.key]
                        )
                      }}
                    >
                      <span className="text-[13px] font-medium text-gray-900">{filter.label}</span>
                    </button>
                    <div className="flex items-center gap-2">
                      {filter.isCustom && (
                        <button
                          onClick={() => {
                            setCustomFilters((prev: Record<string, string>) => {
                              const next = { ...prev }
                              delete next[filter.key]
                              return next
                            })
                            setBookingFilters((prev: string[]) => prev.filter((k) => k !== filter.key))
                          }}
                          className="w-5 h-5 flex items-center justify-center rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                          title="Remove custom filter"
                        >
                          <XMarkIcon className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setBookingFilters((prev: string[]) =>
                            enabled
                              ? prev.filter((k) => k !== filter.key)
                              : [...prev, filter.key]
                          )
                        }}
                      >
                        <div className={`w-8 h-5 rounded-full transition-colors relative ${enabled ? 'bg-primary-500' : 'bg-gray-300'}`}>
                          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${enabled ? 'left-3.5' : 'left-0.5'}`} />
                        </div>
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Add custom filter */}
            <div className="mt-4 pt-3 border-t border-gray-100">
              <p className="text-[12px] font-medium text-gray-700 mb-2">Add Custom Filter</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newFilterLabel}
                  onChange={(e) => setNewFilterLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newFilterLabel.trim()) addCustomFilter()
                  }}
                  placeholder="e.g. Pool Access"
                  className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                />
                <button
                  onClick={addCustomFilter}
                  className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-500 text-white text-[13px] font-medium rounded-lg hover:bg-primary-600 transition-colors"
                >
                  <PlusIcon className="w-3.5 h-3.5" />
                  Add
                </button>
              </div>
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
        )}
      </div>
    </div>
  )
}
