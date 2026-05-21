'use client'

import { useTranslations } from 'next-intl'

interface RateOptionProps {
  /** Used so the accordion can store one expanded id per room. */
  rateType: 'flexible' | 'nonrefundable'
  expanded: boolean
  onToggle: () => void
  /** Renders the leading icon — the no-refund X for non-refundable, the refresh arrow for flexible. */
  iconType: 'flexible' | 'nonrefundable'
  title: string
  description: string
  /** Already-formatted total + per-night strings so the parent owns currency formatting. */
  totalLabel: string
  nightlyLabel: string
  /** Optional `-X% OFF` badge next to the title. */
  discountPercent?: number
  benefits?: string[]
  soldOut: boolean
  onSelect: () => void
}

export default function RateOption({
  rateType,
  expanded,
  onToggle,
  iconType,
  title,
  description,
  totalLabel,
  nightlyLabel,
  discountPercent,
  benefits,
  soldOut,
  onSelect,
}: RateOptionProps) {
  const t = useTranslations('home')

  return (
    <div className={`rounded-xl border-2 overflow-hidden transition-colors ${soldOut ? 'opacity-50 pointer-events-none' : ''} ${expanded ? 'border-primary-500' : 'border-gray-200'}`}>
      <button
        onClick={onToggle}
        disabled={soldOut}
        className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-gray-50/50 transition-colors disabled:cursor-not-allowed"
      >
        <div className="flex items-center gap-3">
          {iconType === 'nonrefundable' ? (
            <svg className="w-5 h-5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          ) : (
            <svg className="w-5 h-5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
          )}
          <div className="text-left">
            <p className="text-sm font-bold text-gray-900 flex items-center gap-2">
              {title}
              {discountPercent != null && discountPercent > 0 && (
                <span className="text-[10px] font-bold bg-primary-600 text-white px-1.5 py-0.5 rounded">-{discountPercent}% OFF</span>
              )}
            </p>
            <p className="text-xs text-gray-500">{description}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-lg font-bold text-gray-900">{totalLabel}</p>
            <p className="text-xs text-gray-500">{t('perNightly', { price: nightlyLabel })}</p>
          </div>
          <svg className={`w-5 h-5 text-gray-400 transition-transform flex-shrink-0 ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-4">
          {benefits && benefits.length > 0 && (
            <>
              <p className="text-xs font-medium text-gray-500 mb-2">{t('includes')}</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-4">
                {benefits.map((benefit) => (
                  <p key={benefit} className="flex items-center gap-2 text-sm text-gray-600">
                    <svg className="w-3.5 h-3.5 text-primary-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                    {benefit}
                  </p>
                ))}
              </div>
            </>
          )}
          <button
            onClick={onSelect}
            disabled={soldOut}
            className="w-full py-2.5 bg-primary-600 text-white font-semibold rounded-lg hover:bg-primary-700 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            data-rate-type={rateType}
          >
            {soldOut ? t('soldOut') : t('selectThisRate')}
          </button>
        </div>
      )}
    </div>
  )
}
