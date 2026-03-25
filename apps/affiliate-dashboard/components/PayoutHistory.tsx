import { CheckCircleIcon, ClockIcon } from '@heroicons/react/24/solid'

interface Payout {
  id: string
  date: string
  amount: number
  status: 'paid' | 'pending'
  method: string
}

const payouts: Payout[] = [
  { id: '1', date: 'Mar 1, 2026', amount: 520, status: 'paid', method: 'Bank Transfer' },
  { id: '2', date: 'Feb 1, 2026', amount: 380, status: 'paid', method: 'Bank Transfer' },
  { id: '3', date: 'Jan 1, 2026', amount: 260, status: 'paid', method: 'PayPal' },
  { id: '4', date: 'Apr 1, 2026', amount: 1260, status: 'pending', method: 'Bank Transfer' },
]

export default function PayoutHistory() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-gray-900">Payout History</h3>
        <a href="#" className="text-sm text-primary-600 hover:text-primary-700 font-medium">
          View all
        </a>
      </div>

      <div className="space-y-3">
        {payouts.map((payout) => (
          <div
            key={payout.id}
            className="flex items-center justify-between py-2.5 border-b border-gray-100 last:border-0"
          >
            <div className="flex items-center gap-3">
              {payout.status === 'paid' ? (
                <CheckCircleIcon className="w-5 h-5 text-success-500" />
              ) : (
                <ClockIcon className="w-5 h-5 text-warning-500" />
              )}
              <div>
                <p className="text-sm font-medium text-gray-900">${payout.amount.toLocaleString()}</p>
                <p className="text-xs text-muted">{payout.date} &middot; {payout.method}</p>
              </div>
            </div>
            <span
              className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                payout.status === 'paid'
                  ? 'bg-success-50 text-success-700'
                  : 'bg-warning-50 text-warning-700'
              }`}
            >
              {payout.status === 'paid' ? 'Paid' : 'Pending'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
