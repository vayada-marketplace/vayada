import { CursorArrowRaysIcon, CreditCardIcon, UserPlusIcon } from '@heroicons/react/24/outline'

interface Activity {
  id: string
  type: 'click' | 'booking' | 'signup'
  message: string
  time: string
  property: string
}

const activities: Activity[] = [
  { id: '1', type: 'booking', message: 'New booking confirmed', time: '2 hours ago', property: 'Sundancer Lombok' },
  { id: '2', type: 'click', message: '12 new link clicks', time: '5 hours ago', property: 'Coral Bay Resort' },
  { id: '3', type: 'booking', message: 'New booking confirmed', time: '1 day ago', property: 'Sundancer Lombok' },
  { id: '4', type: 'click', message: '8 new link clicks', time: '1 day ago', property: 'Sundancer Lombok' },
  { id: '5', type: 'signup', message: 'Guest created an account via your link', time: '2 days ago', property: 'Coral Bay Resort' },
]

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

export default function RecentActivity() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-gray-900">Recent Activity</h3>
        <a href="#" className="text-sm text-primary-600 hover:text-primary-700 font-medium">
          View all
        </a>
      </div>

      <div className="space-y-3">
        {activities.map((activity) => {
          const Icon = iconMap[activity.type]
          return (
            <div
              key={activity.id}
              className="flex items-start gap-3 py-2.5 border-b border-gray-100 last:border-0"
            >
              <div className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${colorMap[activity.type]}`}>
                <Icon className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900">{activity.message}</p>
                <p className="text-xs text-muted mt-0.5">{activity.property} &middot; {activity.time}</p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
