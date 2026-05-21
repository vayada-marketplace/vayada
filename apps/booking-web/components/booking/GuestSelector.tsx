'use client'

import { useRef, useEffect } from 'react'

interface GuestSelectorProps {
  open: boolean
  onClose: () => void
  adults: number
  children: number
  onUpdate: (adults: number, children: number) => void
}

export default function GuestSelector({
  open,
  onClose,
  adults,
  children,
  onUpdate,
}: GuestSelectorProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-3 bg-white rounded-2xl shadow-2xl border border-gray-100 p-5 z-50 w-72"
    >
      <h3 className="text-base font-bold text-gray-900 mb-4">Who&apos;s coming?</h3>

      <div className="space-y-4">
        {/* Adults */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-gray-900">Adults</p>
            <p className="text-xs text-gray-500">Ages 13+</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onUpdate(Math.max(1, adults - 1), children)}
              disabled={adults <= 1}
              className="w-9 h-9 rounded-full border border-gray-300 flex items-center justify-center text-gray-600 hover:border-gray-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <span className="text-lg leading-none">-</span>
            </button>
            <span className="w-6 text-center font-semibold text-gray-900">{adults}</span>
            <button
              onClick={() => onUpdate(Math.min(10, adults + 1), children)}
              disabled={adults >= 10}
              className="w-9 h-9 rounded-full border border-gray-300 flex items-center justify-center text-gray-600 hover:border-gray-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <span className="text-lg leading-none">+</span>
            </button>
          </div>
        </div>

        {/* Children */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-gray-900">Children</p>
            <p className="text-xs text-gray-500">Ages 0-12</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onUpdate(adults, Math.max(0, children - 1))}
              disabled={children <= 0}
              className="w-9 h-9 rounded-full border border-gray-300 flex items-center justify-center text-gray-600 hover:border-gray-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <span className="text-lg leading-none">-</span>
            </button>
            <span className="w-6 text-center font-semibold text-gray-900">{children}</span>
            <button
              onClick={() => onUpdate(adults, Math.min(6, children + 1))}
              disabled={children >= 6}
              className="w-9 h-9 rounded-full border border-gray-300 flex items-center justify-center text-gray-600 hover:border-gray-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <span className="text-lg leading-none">+</span>
            </button>
          </div>
        </div>
      </div>

      <button
        onClick={onClose}
        className="w-full mt-5 py-2.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors text-sm"
      >
        Done
      </button>
    </div>
  )
}
