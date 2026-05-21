'use client'

import { ClipboardDocumentIcon, CheckIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'

interface PropertyCardProps {
  name: string
  commission: number
  status: 'active' | 'pending' | 'paused'
  affiliateLink: string
  bookings: number
  outstanding: number
  clicks: number
  color: string
}

const statusConfig = {
  active: { dot: 'bg-success-500', label: 'active' },
  pending: { dot: 'bg-warning-500', label: 'pending' },
  paused: { dot: 'bg-gray-400', label: 'paused' },
}

export default function PropertyCard({
  name,
  commission,
  status,
  affiliateLink,
  bookings,
  outstanding,
  clicks,
  color,
}: PropertyCardProps) {
  const [copied, setCopied] = useState(false)
  const { dot, label } = statusConfig[status]

  const handleCopy = async () => {
    await navigator.clipboard.writeText(affiliateLink)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden hover:shadow-md transition-shadow">
      {/* Header */}
      <div
        className="px-5 py-4 text-white flex items-center justify-between"
        style={{ background: `linear-gradient(135deg, ${color}, ${color}dd)` }}
      >
        <div>
          <h3 className="font-semibold text-base">{name}</h3>
          <p className="text-white/80 text-sm">
            {commission}% commission &middot; {label}
          </p>
        </div>
        <span className={`w-3 h-3 rounded-full ${dot} ring-2 ring-white/30`} />
      </div>

      {/* Body */}
      <div className="p-5 space-y-4">
        {/* Link */}
        <div>
          <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-1.5">
            Your Link
          </p>
          <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-600 font-mono truncate">
            {affiliateLink}
          </div>
        </div>

        {/* Stats row */}
        {status === 'active' ? (
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-xl font-bold text-gray-900">{bookings}</p>
              <p className="text-xs text-muted uppercase tracking-wider">Bookings</p>
            </div>
            <div>
              <p className="text-xl font-bold text-gray-900">${outstanding.toLocaleString()}</p>
              <p className="text-xs text-muted uppercase tracking-wider">Outstanding</p>
            </div>
            <div>
              <p className="text-xl font-bold text-gray-900">{clicks}</p>
              <p className="text-xs text-muted uppercase tracking-wider">Clicks</p>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2 py-3 bg-warning-50 border border-warning-200 rounded-lg text-warning-700 text-sm">
            <ExclamationTriangleIcon className="w-4 h-4" />
            Approval pending &mdash; link not yet tracked
          </div>
        )}

        {/* Copy button */}
        {status === 'active' ? (
          <button
            onClick={handleCopy}
            className="w-full flex items-center justify-center gap-2 py-2.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            {copied ? (
              <>
                <CheckIcon className="w-4 h-4 text-success-600" />
                Copied!
              </>
            ) : (
              <>
                <ClipboardDocumentIcon className="w-4 h-4" />
                Copy link
              </>
            )}
          </button>
        ) : (
          <button
            disabled
            className="w-full flex items-center justify-center gap-2 py-2.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-400 cursor-not-allowed"
          >
            <ClipboardDocumentIcon className="w-4 h-4" />
            Copy link
          </button>
        )}
      </div>
    </div>
  )
}
