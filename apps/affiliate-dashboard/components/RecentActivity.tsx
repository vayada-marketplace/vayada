'use client'

import { useEffect, useState } from 'react'
import { CursorArrowRaysIcon, CreditCardIcon, UserPlusIcon } from '@heroicons/react/24/outline'
import { apiClient } from '@/services/api/client'
import DataState from '@/components/DataState'

type ActivityType = 'click' | 'booking' | 'signup'

interface Activity {
  type: ActivityType
  ts: string
  property: string
  count: number
}

const iconMap = {
  click: CursorArrowRaysIcon,
  booking: CreditCardIcon,
  signup: UserPlusIcon,
}

const colorMap = {
  click: 'bg-blue-50 text-blue-600',
  booking: 'bg-success-50 text-success-600',
  signup: 'bg-purple-50 text-purple-600',
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  const diff = Date.now() - then
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function message(a: Activity): string {
  if (a.type === 'booking') return 'New booking confirmed'
  if (a.type === 'click')
    return `${a.count} new link click${a.count === 1 ? '' : 's'}`
  return 'Guest created an account via your link'
}

export default function RecentActivity() {
  const [activities, setActivities] = useState<Activity[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    apiClient
      .get<{ activities: Activity[] }>('/affiliate/activity?limit=10')
      .then((res) => setActivities(res.activities))
      .catch(() => setError(true))
  }, [])

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-gray-900">Recent Activity</h3>
        <a href="#" className="text-sm text-primary-600 hover:text-primary-700 font-medium">
          View all
        </a>
      </div>

      <DataState
        data={activities}
        error={error}
        isEmpty={(a) => a.length === 0}
        loadingLabel="Loading activity…"
        errorLabel="Couldn't load activity."
        emptyLabel="No activity yet. Share your referral link to get started."
      >
        {(items) => (
          <div className="space-y-3">
            {items.map((activity) => {
              const Icon = iconMap[activity.type]
              return (
                <div
                  key={`${activity.type}-${activity.ts}-${activity.property}`}
                  className="flex items-start gap-3 py-2.5 border-b border-gray-100 last:border-0"
                >
                  <div className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${colorMap[activity.type]}`}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">{message(activity)}</p>
                    <p className="text-xs text-muted mt-0.5">{activity.property} &middot; {timeAgo(activity.ts)}</p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </DataState>
    </div>
  )
}
