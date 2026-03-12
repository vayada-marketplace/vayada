'use client'

import { useState } from 'react'

interface RoomsTabProps {
  bookingFilters: string[]
  filtersEnabled: boolean
  onToggleFiltersEnabled: () => void
  onAddFilter: (label: string) => void
  onRemoveFilter: (key: string) => void
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
  filtersEnabled,
  onToggleFiltersEnabled,
  onAddFilter,
  onRemoveFilter,
  handleSaveFilters,
  savingFilters,
}: RoomsTabProps) {
  const [newFilter, setNewFilter] = useState('')
  const [showAddInput, setShowAddInput] = useState(false)

  const handleAdd = () => {
    const trimmed = newFilter.trim()
    if (!trimmed) return
    onAddFilter(trimmed)
    setNewFilter('')
    setShowAddInput(false)
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
            {bookingFilters.length === 0 && !showAddInput ? (
              <p className="text-[12px] text-gray-400 mb-3">
                No filters added yet. Add filters below — only add filters that apply to at least one of your rooms.
              </p>
            ) : (
              <div className="space-y-2 mb-3">
                {bookingFilters.map((filter) => (
                  <div key={filter} className="flex items-center justify-between p-3 rounded-lg border border-gray-200 bg-gray-50">
                    <span className="text-[13px] font-medium text-gray-900">{filter}</span>
                    <button
                      onClick={() => onRemoveFilter(filter)}
                      className="text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            {showAddInput ? (
              <div className="flex items-center gap-2 mb-3">
                <input
                  type="text"
                  value={newFilter}
                  onChange={(e) => setNewFilter(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                  placeholder="e.g. Pool View, Free Breakfast..."
                  autoFocus
                  className="flex-1 px-3 py-2 text-[13px] border border-gray-200 rounded-lg bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-500"
                />
                <button
                  onClick={handleAdd}
                  disabled={!newFilter.trim()}
                  className="px-3 py-2 text-[13px] font-medium bg-primary-500 text-white rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors"
                >
                  Add
                </button>
                <button
                  onClick={() => { setShowAddInput(false); setNewFilter('') }}
                  className="px-3 py-2 text-[13px] font-medium text-gray-500 hover:text-gray-700 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowAddInput(true)}
                className="text-[13px] font-medium text-primary-600 hover:text-primary-700 transition-colors"
              >
                + Add Filter
              </button>
            )}

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
