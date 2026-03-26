'use client'

import {
  PlusIcon,
  PencilSquareIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import type { PromoCodeItem } from '@/services/settings'

interface PromoCodesTabProps {
  promoCodes: PromoCodeItem[]
  deletingId: string | null
  openCreateModal: () => void
  openEditModal: (promo: PromoCodeItem) => void
  handleDeletePromoCode: (id: string) => void
}

export default function PromoCodesTab({
  promoCodes,
  deletingId,
  openCreateModal,
  openEditModal,
  handleDeletePromoCode,
}: PromoCodesTabProps) {
  return (
    <div className="max-w-2xl space-y-4">
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-[14px] font-semibold text-gray-900">Promo Codes</h2>
            <p className="text-[12px] text-gray-500 mt-0.5">Create discount codes guests can apply during booking</p>
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
                key={promo.id}
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
                        : `${promo.discountValue} fixed`}
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
                        {promo.useCount}/{promo.maxUses} uses
                      </span>
                    )}
                    {promo.maxUses == null && promo.useCount > 0 && (
                      <span className="text-[11px] text-gray-400">
                        {promo.useCount} uses
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
                    onClick={() => handleDeletePromoCode(promo.id)}
                    disabled={deletingId === promo.id}
                    className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors disabled:opacity-50"
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
