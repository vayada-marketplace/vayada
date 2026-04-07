'use client'

import { useState, useEffect } from 'react'
import { PlusIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { pmsClient } from '@/services/api/pmsClient'
import { SaveButton } from '@/components/ui'

interface Tier {
  daysBeforeMin: number
  daysBeforeMax: number | null
  discountPercent: number
}

interface LastMinuteConfig {
  enabled: boolean
  stackWithPromo: boolean
  tiers: Tier[]
}

const DEFAULT_TIERS: Tier[] = [
  { daysBeforeMin: 7, daysBeforeMax: 13, discountPercent: 10 },
  { daysBeforeMin: 3, daysBeforeMax: 6, discountPercent: 20 },
  { daysBeforeMin: 0, daysBeforeMax: 2, discountPercent: 30 },
]

export default function LastMinuteTab() {
  const [config, setConfig] = useState<LastMinuteConfig>({
    enabled: false,
    stackWithPromo: false,
    tiers: [],
  })
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  useEffect(() => {
    pmsClient.get<{ last_minute_discount: LastMinuteConfig | null }>('/admin/hotel')
      .then((hotel) => {
        if (hotel.last_minute_discount) {
          setConfig(hotel.last_minute_discount)
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setFeedback(null)
    try {
      await pmsClient.patch('/admin/hotel', {
        last_minute_discount: config,
      })
      setFeedback({ type: 'success', message: 'Last-minute discount settings saved' })
    } catch {
      setFeedback({ type: 'error', message: 'Failed to save settings' })
    } finally {
      setSaving(false)
    }
  }

  const addTier = () => {
    setConfig((prev) => ({
      ...prev,
      tiers: [
        ...prev.tiers,
        { daysBeforeMin: 0, daysBeforeMax: null, discountPercent: 10 },
      ],
    }))
  }

  const removeTier = (index: number) => {
    setConfig((prev) => ({
      ...prev,
      tiers: prev.tiers.filter((_, i) => i !== index),
    }))
  }

  const updateTier = (index: number, field: keyof Tier, value: number | null) => {
    setConfig((prev) => ({
      ...prev,
      tiers: prev.tiers.map((t, i) => (i === index ? { ...t, [field]: value } : t)),
    }))
  }

  const applyPreset = () => {
    setConfig((prev) => ({ ...prev, tiers: [...DEFAULT_TIERS] }))
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <div className="w-5 h-5 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {feedback && (
        <div className={`p-3 rounded-lg text-sm ${feedback.type === 'success' ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-red-50 border border-red-200 text-red-700'}`}>
          {feedback.message}
        </div>
      )}

      {/* Enable toggle */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Last-Minute Discounts</h2>
            <p className="text-[12px] text-gray-500 mt-0.5">
              Automatically reduce prices when check-in is approaching to fill empty rooms
            </p>
          </div>
          <button
            type="button"
            onClick={() => setConfig((prev) => ({ ...prev, enabled: !prev.enabled }))}
            className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${config.enabled ? 'bg-primary-500' : 'bg-gray-300'}`}
          >
            <div className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform ${config.enabled ? 'left-[20px]' : 'left-[2px]'}`} />
          </button>
        </div>
      </div>

      {config.enabled && (
        <>
          {/* Stacking toggle */}
          <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] font-medium text-gray-900">Stack with promo codes</p>
                <p className="text-[12px] text-gray-500 mt-0.5">
                  When off, only the larger discount applies (last-minute or promo)
                </p>
              </div>
              <button
                type="button"
                onClick={() => setConfig((prev) => ({ ...prev, stackWithPromo: !prev.stackWithPromo }))}
                className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${config.stackWithPromo ? 'bg-primary-500' : 'bg-gray-300'}`}
              >
                <div className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform ${config.stackWithPromo ? 'left-[20px]' : 'left-[2px]'}`} />
              </button>
            </div>
          </div>

          {/* Discount tiers */}
          <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Discount Tiers</h3>
                <p className="text-[12px] text-gray-500 mt-0.5">
                  Define discounts based on days before check-in
                </p>
              </div>
              <button
                type="button"
                onClick={applyPreset}
                className="text-[12px] font-medium text-primary-600 hover:text-primary-700 transition-colors"
              >
                Use recommended tiers
              </button>
            </div>

            {config.tiers.length === 0 ? (
              <div className="text-center py-6">
                <p className="text-[13px] text-gray-500 mb-3">No tiers configured yet</p>
                <button
                  type="button"
                  onClick={applyPreset}
                  className="px-4 py-2 text-[13px] font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
                >
                  Start with recommended tiers
                </button>
              </div>
            ) : (
              <div className="space-y-2.5">
                {config.tiers
                  .sort((a, b) => b.daysBeforeMin - a.daysBeforeMin)
                  .map((tier, idx) => (
                    <div key={idx} className="flex items-center gap-2 md:gap-3 bg-gray-50 rounded-lg p-3">
                      <div className="flex-1 grid grid-cols-3 gap-2 md:gap-3">
                        <div>
                          <label className="block text-[10px] text-gray-400 mb-0.5">From (days)</label>
                          <input
                            type="number"
                            min={0}
                            value={tier.daysBeforeMin}
                            onChange={(e) => updateTier(idx, 'daysBeforeMin', parseInt(e.target.value) || 0)}
                            className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-gray-400 mb-0.5">To (days)</label>
                          <input
                            type="number"
                            min={0}
                            value={tier.daysBeforeMax ?? ''}
                            onChange={(e) => updateTier(idx, 'daysBeforeMax', e.target.value ? parseInt(e.target.value) : null)}
                            placeholder="∞"
                            className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-gray-400 mb-0.5">Discount %</label>
                          <input
                            type="number"
                            min={1}
                            max={90}
                            value={tier.discountPercent}
                            onChange={(e) => updateTier(idx, 'discountPercent', parseInt(e.target.value) || 0)}
                            className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-[13px] font-semibold focus:outline-none focus:ring-2 focus:ring-primary-500"
                          />
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeTier(idx)}
                        className="p-1.5 text-gray-400 hover:text-red-500 transition-colors shrink-0"
                      >
                        <XMarkIcon className="w-4 h-4" />
                      </button>
                    </div>
                  ))}

                <button
                  type="button"
                  onClick={addTier}
                  className="inline-flex items-center gap-1.5 text-[12px] font-medium text-gray-600 hover:text-primary-600 transition-colors mt-1"
                >
                  <PlusIcon className="w-3.5 h-3.5" /> Add tier
                </button>
              </div>
            )}

            {/* Example preview */}
            {config.tiers.length > 0 && (
              <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-3">
                <p className="text-[11px] font-semibold text-amber-800 uppercase tracking-wider mb-2">How it works</p>
                <div className="space-y-1">
                  {config.tiers
                    .filter((t) => t.discountPercent > 0)
                    .sort((a, b) => b.daysBeforeMin - a.daysBeforeMin)
                    .map((tier, idx) => (
                      <p key={idx} className="text-[12px] text-amber-700">
                        {tier.daysBeforeMax != null
                          ? `${tier.daysBeforeMin}–${tier.daysBeforeMax} days before check-in`
                          : `${tier.daysBeforeMin}+ days before check-in`}
                        {' → '}
                        <span className="font-semibold">{tier.discountPercent}% off</span>
                      </p>
                    ))}
                </div>
              </div>
            )}
          </div>

          {/* Save */}
          <div className="flex justify-end">
            <SaveButton onClick={handleSave} saving={saving} />
          </div>
        </>
      )}
    </div>
  )
}
