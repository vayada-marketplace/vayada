'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { authService } from '@/services/auth'
import { usersService } from '@/services/api/users'
import { ApiErrorResponse } from '@/services/api/client'
import type { User } from '@/lib/types'

export default function DashboardPage() {
  const router = useRouter()
  const [stats, setStats] = useState({
    total: 0,
    pending: 0,
    verified: 0,
    rejected: 0,
    suspended: 0,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!authService.isLoggedIn() || !authService.isAdmin()) {
      router.push('/login')
      return
    }

    loadStats()
  }, [router])

  const loadStats = async () => {
    try {
      setLoading(true)
      setError('')
      
      // Fetch first page to get total count, then calculate stats from all statuses
      const [allResponse, pendingResponse, verifiedResponse, rejectedResponse, suspendedResponse] = await Promise.all([
        usersService.getAllUsers({ page: 1, page_size: 1 }),
        usersService.getAllUsers({ status: 'pending', page: 1, page_size: 1 }),
        usersService.getAllUsers({ status: 'verified', page: 1, page_size: 1 }),
        usersService.getAllUsers({ status: 'rejected', page: 1, page_size: 1 }),
        usersService.getAllUsers({ status: 'suspended', page: 1, page_size: 1 }),
      ])
      
      setStats({
        total: allResponse.total || 0,
        pending: pendingResponse.total || 0,
        verified: verifiedResponse.total || 0,
        rejected: rejectedResponse.total || 0,
        suspended: suspendedResponse.total || 0,
      })
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        // If endpoint doesn't exist yet, show placeholder
        if (err.status === 404) {
          setError('Admin endpoints not yet configured. Please set up backend admin routes.')
        } else {
          setError(err.data.detail as string || 'Failed to load statistics')
        }
      } else {
        setError('Failed to load dashboard statistics')
      }
    } finally {
      setLoading(false)
    }
  }

  const statCards = [
    { label: 'Total Users', value: stats.total, color: 'bg-blue-500' },
    { label: 'Pending', value: stats.pending, color: 'bg-yellow-500' },
    { label: 'Verified', value: stats.verified, color: 'bg-green-500' },
    { label: 'Rejected', value: stats.rejected, color: 'bg-red-500' },
    { label: 'Suspended', value: stats.suspended, color: 'bg-gray-500' },
  ]

  return (
    <div className="px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
        <p className="mt-2 text-gray-600">Overview of user management</p>
      </div>

      {error && (
        <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <p className="text-sm text-yellow-800">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12">
          <p className="text-gray-600">Loading statistics...</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-5">
          {statCards.map((card) => (
            <div
              key={card.label}
              className="bg-white overflow-hidden shadow rounded-lg"
            >
              <div className="p-5">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <div className={`${card.color} rounded-md p-3`}>
                      <div className="w-6 h-6 bg-white rounded opacity-50"></div>
                    </div>
                  </div>
                  <div className="ml-5 w-0 flex-1">
                    <dl>
                      <dt className="text-sm font-medium text-gray-500 truncate">
                        {card.label}
                      </dt>
                      <dd className="text-2xl font-semibold text-gray-900">
                        {card.value}
                      </dd>
                    </dl>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-8">
        <a
          href="/dashboard/users"
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
        >
          Manage Users →
        </a>
      </div>
    </div>
  )
}

