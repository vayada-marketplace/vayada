'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ArrowLeftIcon, CheckCircleIcon, XCircleIcon, NoSymbolIcon } from '@heroicons/react/24/outline'
import { affiliatesService, Affiliate } from '@/services/affiliates'

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-600',
  suspended: 'bg-gray-100 text-gray-600',
}

export default function AffiliateDetailPage({ params }: { params: { id: string } }) {
  const [affiliate, setAffiliate] = useState<Affiliate | null>(null)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [editingCommission, setEditingCommission] = useState(false)
  const [commissionInput, setCommissionInput] = useState('')

  useEffect(() => {
    affiliatesService.get(params.id)
      .then(setAffiliate)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [params.id])

  const updateStatus = async (status: 'approved' | 'rejected' | 'suspended') => {
    if (!confirm(`Are you sure you want to ${status === 'approved' ? 'approve' : status === 'rejected' ? 'reject' : 'suspend'} this affiliate?`)) return
    setUpdating(true)
    setError('')
    setSuccess('')
    try {
      const updated = await affiliatesService.updateStatus(params.id, status)
      setAffiliate(updated)
      setSuccess(`Affiliate ${status} successfully`)
    } catch (err: any) {
      setError(err.message || 'Failed to update status')
    } finally {
      setUpdating(false)
    }
  }

  const saveCommission = async () => {
    const val = parseFloat(commissionInput)
    if (isNaN(val) || val < 0 || val > 100) {
      setError('Commission must be between 0 and 100')
      return
    }
    setUpdating(true)
    setError('')
    setSuccess('')
    try {
      const updated = await affiliatesService.updateCommission(params.id, val)
      setAffiliate(updated)
      setEditingCommission(false)
      setSuccess('Commission updated successfully')
    } catch (err: any) {
      setError(err.message || 'Failed to update commission')
    } finally {
      setUpdating(false)
    }
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    )
  }

  if (!affiliate) {
    return (
      <div className="p-6">
        <p className="text-gray-500">Affiliate not found.</p>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/affiliates" className="text-gray-400 hover:text-gray-600">
          <ArrowLeftIcon className="w-5 h-5" />
        </Link>
        <h1 className="text-xl font-bold text-gray-900">{affiliate.fullName}</h1>
        <span className={`ml-2 inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[affiliate.status] || ''}`}>
          {affiliate.status}
        </span>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
          {success}
        </div>
      )}

      <div className="space-y-6">
        {/* Affiliate Information */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Affiliate Information</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-gray-500">Full Name</p>
              <p className="font-medium text-gray-900">{affiliate.fullName}</p>
            </div>
            <div>
              <p className="text-gray-500">Email</p>
              <p className="font-medium text-gray-900">{affiliate.email}</p>
            </div>
            <div>
              <p className="text-gray-500">Social Media</p>
              <p className="font-medium text-gray-900">{affiliate.socialMedia || '-'}</p>
            </div>
            <div>
              <p className="text-gray-500">Type</p>
              <p className="font-medium text-gray-900 capitalize">{affiliate.userType}</p>
            </div>
            <div>
              <p className="text-gray-500">Referral Code</p>
              <p className="font-medium text-gray-900 font-mono">{affiliate.referralCode}</p>
            </div>
            <div>
              <p className="text-gray-500">Registered</p>
              <p className="font-medium text-gray-900">{affiliate.createdAt}</p>
            </div>
          </div>
        </div>

        {/* Payment Details */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Payment Details</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-gray-500">Payment Method</p>
              <p className="font-medium text-gray-900 capitalize">{affiliate.paymentMethod}</p>
            </div>
            {affiliate.paymentMethod === 'paypal' && (
              <div>
                <p className="text-gray-500">PayPal Email</p>
                <p className="font-medium text-gray-900">{affiliate.paypalEmail || '-'}</p>
              </div>
            )}
            {affiliate.paymentMethod === 'bank' && (
              <div>
                <p className="text-gray-500">IBAN</p>
                <p className="font-medium text-gray-900 font-mono">{affiliate.bankIban || '-'}</p>
              </div>
            )}
          </div>
        </div>

        {/* Commission & Stats */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Commission & Performance</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div className="bg-gray-50 rounded-lg p-4 text-center">
              <p className="text-2xl font-bold text-gray-900">{affiliate.bookingCount}</p>
              <p className="text-xs text-gray-500 mt-1">Referred Bookings</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-4 text-center">
              <p className="text-2xl font-bold text-gray-900">
                {affiliate.totalRevenue > 0 ? `EUR ${affiliate.totalRevenue.toFixed(2)}` : '-'}
              </p>
              <p className="text-xs text-gray-500 mt-1">Total Revenue</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-4 text-center">
              <p className="text-2xl font-bold text-primary-600">
                {affiliate.totalCommission > 0 ? `EUR ${affiliate.totalCommission.toFixed(2)}` : '-'}
              </p>
              <p className="text-xs text-gray-500 mt-1">Earned Commission</p>
            </div>
          </div>

          {/* Commission Editor */}
          <div className="flex items-center gap-3 pt-3 border-t border-gray-100">
            <span className="text-sm text-gray-500">Commission Rate:</span>
            {editingCommission ? (
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.5"
                  value={commissionInput}
                  onChange={(e) => setCommissionInput(e.target.value)}
                  className="w-20 px-2 py-1 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
                <span className="text-sm text-gray-500">%</span>
                <button
                  onClick={saveCommission}
                  disabled={updating}
                  className="px-3 py-1 text-xs font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  onClick={() => setEditingCommission(false)}
                  className="px-3 py-1 text-xs font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-gray-900">{affiliate.commissionPct}%</span>
                <button
                  onClick={() => { setCommissionInput(String(affiliate.commissionPct)); setEditingCommission(true) }}
                  className="text-xs text-primary-600 hover:text-primary-700 font-medium"
                >
                  Edit
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-3">
          {affiliate.status === 'pending' && (
            <>
              <button
                onClick={() => updateStatus('approved')}
                disabled={updating}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
              >
                <CheckCircleIcon className="w-4 h-4" />
                Approve
              </button>
              <button
                onClick={() => updateStatus('rejected')}
                disabled={updating}
                className="inline-flex items-center gap-1.5 px-4 py-2 border border-red-200 text-red-600 text-sm font-medium rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                <XCircleIcon className="w-4 h-4" />
                Reject
              </button>
            </>
          )}
          {affiliate.status === 'approved' && (
            <button
              onClick={() => updateStatus('suspended')}
              disabled={updating}
              className="inline-flex items-center gap-1.5 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              <NoSymbolIcon className="w-4 h-4" />
              Suspend
            </button>
          )}
          {affiliate.status === 'rejected' && (
            <button
              onClick={() => updateStatus('approved')}
              disabled={updating}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
            >
              <CheckCircleIcon className="w-4 h-4" />
              Approve
            </button>
          )}
          {affiliate.status === 'suspended' && (
            <button
              onClick={() => updateStatus('approved')}
              disabled={updating}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
            >
              <CheckCircleIcon className="w-4 h-4" />
              Reactivate
            </button>
          )}
        </div>

        {/* Metadata */}
        <div className="text-xs text-gray-400">
          <p>Created: {affiliate.createdAt}</p>
          <p>Last updated: {affiliate.updatedAt}</p>
        </div>
      </div>
    </div>
  )
}
