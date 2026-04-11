'use client'

import { useState } from 'react'
import {
  PlusIcon,
  PencilSquareIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'

export interface SetupPromoCode {
  _localId: string
  code: string
  discountType: 'percentage' | 'fixed'
  discountValue: number
  validFrom: string | null
  validUntil: string | null
  isActive: boolean
  maxUses: number | null
}

export function createEmptyPromoCode(): SetupPromoCode {
  return {
    _localId: crypto.randomUUID(),
    code: '',
    discountType: 'percentage',
    discountValue: 0,
    validFrom: null,
    validUntil: null,
    isActive: true,
    maxUses: null,
  }
}

interface PromoCodesStepProps {
  promoCodes: SetupPromoCode[]
  setPromoCodes: (promoCodes: SetupPromoCode[]) => void
  currency: string
  error: string
  canProceed: boolean
  onBack: () => void
  onContinue: () => void
  stepIndicators: React.ReactNode
}

export default function PromoCodesStep({
  promoCodes,
  setPromoCodes,
  currency,
  error,
  canProceed,
  onBack,
  onContinue,
  stepIndicators,
}: PromoCodesStepProps) {
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formData, setFormData] = useState(() => createEmptyPromoCode())

  const openCreateModal = () => {
    setEditingId(null)
    setFormData(createEmptyPromoCode())
    setShowModal(true)
  }

  const openEditModal = (promo: SetupPromoCode) => {
    setEditingId(promo._localId)
    setFormData({ ...promo })
    setShowModal(true)
  }

  const handleDelete = (localId: string) => {
    setPromoCodes(promoCodes.filter((p) => p._localId !== localId))
  }

  const handleSave = () => {
    if (!formData.code.trim() || formData.discountValue <= 0) return
    const cleaned: SetupPromoCode = {
      ...formData,
      code: formData.code.trim().toUpperCase(),
    }
    if (editingId) {
      setPromoCodes(promoCodes.map((p) => (p._localId === editingId ? cleaned : p)))
    } else {
      setPromoCodes([...promoCodes, cleaned])
    }
    setShowModal(false)
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6">
        {stepIndicators}
        <div className="text-center mb-6">
          <h2 className="text-lg font-bold text-gray-900">Promo Codes</h2>
          <p className="text-[13px] text-gray-500 mt-1">
            Create discount codes guests can apply during booking
          </p>
        </div>

        {/* Promo Codes List */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 mb-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-[14px] font-semibold text-gray-900">Discount Codes</h3>
              <p className="text-[12px] text-gray-500 mt-0.5">Promo codes for guest discounts</p>
            </div>
            <button
              onClick={openCreateModal}
              className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-500 text-white text-[12px] font-medium rounded-lg hover:bg-primary-600 transition-colors"
            >
              <PlusIcon className="w-3.5 h-3.5" />
              Add Promo Code
            </button>
          </div>

          {promoCodes.length === 0 ? (
            <div className="bg-gray-50 rounded-lg border border-dashed border-gray-300 p-6 text-center">
              <div className="w-10 h-10 bg-gray-200 rounded-full mx-auto flex items-center justify-center mb-2">
                <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                </svg>
              </div>
              <p className="text-[13px] font-medium text-gray-600">No promo codes yet</p>
              <p className="text-[12px] text-gray-400 mt-0.5">Create your first promo code to offer discounts to guests</p>
            </div>
          ) : (
            <div className="space-y-2">
              {promoCodes.map((promo) => (
                <div
                  key={promo._localId}
                  className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors"
                >
                  {/* Code badge */}
                  <div className="shrink-0">
                    <span className="inline-flex items-center px-2.5 py-1 rounded-md bg-gray-100 text-[12px] font-mono font-semibold text-gray-800 tracking-wide">
                      {promo.code}
                    </span>
                  </div>

                  {/* Discount info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                        promo.discountType === 'percentage'
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-green-100 text-green-700'
                      }`}>
                        {promo.discountType === 'percentage'
                          ? `${promo.discountValue}% off`
                          : `${promo.discountValue} ${currency} off`}
                      </span>
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                        promo.isActive
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}>
                        {promo.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1">
                      {(promo.validFrom || promo.validUntil) && (
                        <span className="text-[11px] text-gray-400">
                          {promo.validFrom && promo.validUntil
                            ? `${promo.validFrom} \u2013 ${promo.validUntil}`
                            : promo.validFrom
                              ? `From ${promo.validFrom}`
                              : `Until ${promo.validUntil}`}
                        </span>
                      )}
                      {promo.maxUses != null && (
                        <span className="text-[11px] text-gray-400">
                          Max {promo.maxUses} uses
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => openEditModal(promo)}
                      className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
                    >
                      <PencilSquareIcon className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(promo._localId)}
                      className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors"
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Tip */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4">
          <p className="text-[12px] text-blue-700">
            This step is optional — you can skip it and create promo codes later from Booking Flow settings.
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
            <p className="text-[12px] text-red-700 font-medium">{error}</p>
          </div>
        )}

        <div className="mt-6 flex justify-between">
          <button
            onClick={onBack}
            className="px-4 py-2 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Back
          </button>
          <button
            onClick={onContinue}
            disabled={!canProceed}
            className="px-6 py-2 bg-primary-500 text-white text-[14px] font-semibold rounded-lg hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {promoCodes.length === 0 ? 'Skip for Now' : 'Continue'} &rarr;
          </button>
        </div>
      </div>

      {/* ADD/EDIT PROMO CODE MODAL */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowModal(false)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-[15px] font-semibold text-gray-900">
                {editingId ? 'Edit Promo Code' : 'Create Promo Code'}
              </h3>
              <button onClick={() => setShowModal(false)} className="p-1 text-gray-400 hover:text-gray-600 rounded-md">
                <XMarkIcon className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              {/* Code */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Code *</label>
                <input
                  type="text"
                  value={formData.code}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] font-mono tracking-wider focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  placeholder="e.g., SUMMER20"
                />
              </div>

              {/* Discount Type + Value */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Discount Type</label>
                  <select
                    value={formData.discountType}
                    onChange={(e) => setFormData({ ...formData, discountType: e.target.value as 'percentage' | 'fixed' })}
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white"
                  >
                    <option value="percentage">Percentage (%)</option>
                    <option value="fixed">Fixed Amount</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                    Value * {formData.discountType === 'percentage' ? '(%)' : `(${currency})`}
                  </label>
                  <input
                    type="number"
                    min="0"
                    step={formData.discountType === 'percentage' ? '1' : '0.01'}
                    max={formData.discountType === 'percentage' ? '100' : undefined}
                    value={formData.discountValue || ''}
                    onChange={(e) => setFormData({ ...formData, discountValue: parseFloat(e.target.value) || 0 })}
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </div>
              </div>

              {/* Valid From / Until */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Valid From <span className="text-gray-400">(optional)</span></label>
                  <input
                    type="date"
                    value={formData.validFrom || ''}
                    onChange={(e) => setFormData({ ...formData, validFrom: e.target.value || null })}
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Valid Until <span className="text-gray-400">(optional)</span></label>
                  <input
                    type="date"
                    value={formData.validUntil || ''}
                    onChange={(e) => setFormData({ ...formData, validUntil: e.target.value || null })}
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                </div>
              </div>

              {/* Max Uses */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Max Uses <span className="text-gray-400">(optional, leave empty for unlimited)</span></label>
                <input
                  type="number"
                  min="1"
                  value={formData.maxUses ?? ''}
                  onChange={(e) => setFormData({ ...formData, maxUses: e.target.value ? parseInt(e.target.value) : null })}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  placeholder="Unlimited"
                />
              </div>

              {/* Active toggle */}
              <div className="flex items-center justify-between py-1">
                <div>
                  <p className="text-[12px] font-medium text-gray-700">Active</p>
                  <p className="text-[11px] text-gray-400">Guests can use this code immediately</p>
                </div>
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, isActive: !formData.isActive })}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    formData.isActive ? 'bg-primary-500' : 'bg-gray-300'
                  }`}
                >
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                    formData.isActive ? 'translate-x-[18px]' : 'translate-x-[3px]'
                  }`} />
                </button>
              </div>
            </div>

            <div className="p-4 border-t border-gray-200 flex gap-2">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 py-2 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!formData.code.trim() || formData.discountValue <= 0}
                className="flex-1 py-2 text-[13px] font-medium text-white bg-primary-500 rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors"
              >
                {editingId ? 'Save Changes' : 'Add'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
