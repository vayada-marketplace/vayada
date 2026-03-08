'use client'

function PaymentIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="4" width="22" height="16" rx="2" />
      <path d="M1 10h22" />
      <path d="M6 16h4" />
    </svg>
  )
}

export default function PaymentTab() {
  return (
    <div className="max-w-2xl">
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h2 className="text-[14px] font-semibold text-gray-900">Payment Configuration</h2>
        <p className="text-[12px] text-gray-500 mt-0.5 mb-4">Payment methods and policies are managed in the Property Manager</p>

        <div className="bg-gray-50 rounded-lg border border-gray-200 p-6 text-center">
          <div className="w-10 h-10 bg-gray-200 rounded-full mx-auto flex items-center justify-center mb-2">
            <PaymentIcon className="w-5 h-5 text-gray-400" />
          </div>
          <p className="text-[13px] font-medium text-gray-600">Go to PMS Settings to configure payments</p>
          <p className="text-[12px] text-gray-400 mt-0.5">Stripe, pay at property, and cancellation policies are configured in the Property Manager</p>
        </div>
      </div>
    </div>
  )
}
