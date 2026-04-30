'use client'

import { useTranslations } from 'next-intl'

interface RoomFiltersBarProps {
  filters: string[]
  activeFilters: string[]
  onToggleFilter: (filter: string) => void
  sortOption: string
  onSortChange: (next: string) => void
}

export default function RoomFiltersBar({
  filters,
  activeFilters,
  onToggleFilter,
  sortOption,
  onSortChange,
}: RoomFiltersBarProps) {
  const t = useTranslations('home')

  return (
    <div className="mb-6">
      {filters.length > 0 && (
        <>
          <div className="flex items-center gap-1.5 text-sm text-gray-500 mb-3">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            {t('popularFilters')}
          </div>
          <div className="h-px bg-gray-200 mb-4" />
          <div className="flex items-center gap-2.5 flex-wrap mb-4">
            {filters.map((filter) => (
              <button
                key={filter}
                onClick={() => onToggleFilter(filter)}
                className={`px-4 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                  activeFilters.includes(filter)
                    ? 'border-gray-900 text-gray-900'
                    : 'border-gray-300 text-gray-600 hover:border-gray-400'
                }`}
              >
                {filter}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="flex justify-end">
        <div className="flex items-center gap-2 flex-shrink-0">
          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
          </svg>
          <select
            value={sortOption}
            onChange={(e) => onSortChange(e.target.value)}
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <option value="recommended">{t('recommended')}</option>
            <option value="roomSize">{t('roomSize')}</option>
            <option value="priceLow">{t('priceLowHigh')}</option>
            <option value="priceHigh">{t('priceHighLow')}</option>
          </select>
        </div>
      </div>
    </div>
  )
}
