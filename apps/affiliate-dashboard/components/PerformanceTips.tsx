import { LightBulbIcon, ArrowTrendingUpIcon, ShareIcon } from '@heroicons/react/24/outline'

const tips = [
  {
    icon: ArrowTrendingUpIcon,
    title: 'Peak booking season ahead',
    description: 'April-June sees 40% more bookings. Share your links now to maximize earnings.',
  },
  {
    icon: ShareIcon,
    title: 'Instagram Stories convert best',
    description: 'Affiliates who share via Stories see 2.3x higher click-through rates.',
  },
  {
    icon: LightBulbIcon,
    title: 'Add your link to your bio',
    description: 'A permanent link in your social bio generates steady passive clicks.',
  },
]

export default function PerformanceTips() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <h3 className="font-semibold text-gray-900 mb-4">Performance Tips</h3>
      <div className="space-y-4">
        {tips.map((tip, i) => (
          <div key={i} className="flex gap-3">
            <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-primary-50 flex items-center justify-center">
              <tip.icon className="w-5 h-5 text-primary-600" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">{tip.title}</p>
              <p className="text-xs text-muted mt-0.5 leading-relaxed">{tip.description}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
