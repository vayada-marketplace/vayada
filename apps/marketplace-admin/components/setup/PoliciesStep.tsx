'use client'

export const TIME_OPTIONS = Array.from({ length: 24 }, (_, i) => {
  const h = i.toString().padStart(2, '0')
  return { value: `${h}:00`, label: `${h}:00` }
})

interface PoliciesStepProps {
  checkInTime: string; setCheckInTime: (v: string) => void
  checkOutTime: string; setCheckOutTime: (v: string) => void
  minimumStay: number; setMinimumStay: (v: number) => void
  payAtHotel: boolean; setPayAtHotel: (v: boolean) => void
  onlineCardPayment: boolean; setOnlineCardPayment: (v: boolean) => void
  bankTransfer: boolean; setBankTransfer: (v: boolean) => void
  specialRequests: boolean; setSpecialRequests: (v: boolean) => void
  estimatedArrivalTime: boolean; setEstimatedArrivalTime: (v: boolean) => void
  numberOfGuests: boolean; setNumberOfGuests: (v: boolean) => void
  enableReferAGuest: boolean; setEnableReferAGuest: (v: boolean) => void
  error: string
  saving: boolean
  onBack: () => void
  onComplete: () => void
  stepIndicators: React.ReactNode
}

export default function PoliciesStep({
  checkInTime, setCheckInTime,
  checkOutTime, setCheckOutTime,
  minimumStay, setMinimumStay,
  payAtHotel, setPayAtHotel,
  onlineCardPayment, setOnlineCardPayment,
  bankTransfer, setBankTransfer,
  specialRequests, setSpecialRequests,
  estimatedArrivalTime, setEstimatedArrivalTime,
  numberOfGuests, setNumberOfGuests,
  enableReferAGuest, setEnableReferAGuest,
  error,
  saving,
  onBack,
  onComplete,
  stepIndicators,
}: PoliciesStepProps) {
  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-2xl mx-auto px-6 py-6">
        {stepIndicators}
        <div className="text-center mb-6">
          <h2 className="text-lg font-bold text-gray-900">Policies & Operations</h2>
          <p className="text-[13px] text-gray-500 mt-1">Configure check-in/out times, payment methods, and guest options</p>
        </div>

        {/* Check-in & Check-out */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-3 mb-4">
          <h3 className="text-[13px] font-semibold text-gray-900">Check-in & Check-out</h3>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-[13px] font-medium text-gray-700 mb-1">Check-in Time</label>
              <select
                value={checkInTime}
                onChange={(e) => setCheckInTime(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white text-gray-900"
              >
                {TIME_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 mb-1">Check-out Time</label>
              <select
                value={checkOutTime}
                onChange={(e) => setCheckOutTime(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white text-gray-900"
              >
                {TIME_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 mb-1">Minimum Stay (nights)</label>
              <input
                type="number"
                min={1}
                value={minimumStay}
                onChange={(e) => setMinimumStay(Math.max(1, Number(e.target.value)))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900"
              />
            </div>
          </div>
        </div>

        {/* Payment Methods */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-3 mb-4">
          <h3 className="text-[13px] font-semibold text-gray-900">Payment Methods</h3>
          <p className="text-[12px] text-gray-500 mb-2">Choose which payment options are available to guests</p>

          {[
            { label: 'Pay at Hotel', value: payAtHotel, setter: setPayAtHotel, desc: 'Guests pay upon arrival at the property' },
            { label: 'Online Card Payment', value: onlineCardPayment, setter: setOnlineCardPayment, desc: 'Accept credit/debit card payments online' },
            { label: 'Bank Transfer', value: bankTransfer, setter: setBankTransfer, desc: 'Allow guests to pay via bank transfer' },
          ].map((item) => (
            <button
              key={item.label}
              onClick={() => item.setter(!item.value)}
              className={`w-full flex items-center justify-between p-3 rounded-lg border transition-all text-left ${
                item.value
                  ? 'border-primary-500 bg-primary-50/30 ring-1 ring-primary-500'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div>
                <span className="text-[13px] font-medium text-gray-900">{item.label}</span>
                <p className="text-[11px] text-gray-500 mt-0.5">{item.desc}</p>
              </div>
              <div className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${item.value ? 'bg-primary-500' : 'bg-gray-300'}`}>
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${item.value ? 'left-4' : 'left-0.5'}`} />
              </div>
            </button>
          ))}
        </div>

        {/* Guest Information Form */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-3 mb-4">
          <h3 className="text-[13px] font-semibold text-gray-900">Guest Information Form</h3>
          <p className="text-[12px] text-gray-500 mb-2">Additional fields shown to guests during the booking process</p>

          {[
            { label: 'Special Requests', value: specialRequests, setter: setSpecialRequests, badge: 'Recommended' },
            { label: 'Estimated Arrival Time', value: estimatedArrivalTime, setter: setEstimatedArrivalTime, badge: '' },
            { label: 'Number of Guests', value: numberOfGuests, setter: setNumberOfGuests, badge: '' },
          ].map((item) => (
            <button
              key={item.label}
              onClick={() => item.setter(!item.value)}
              className={`w-full flex items-center justify-between p-3 rounded-lg border transition-all text-left ${
                item.value
                  ? 'border-primary-500 bg-primary-50/30 ring-1 ring-primary-500'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-gray-900">{item.label}</span>
                {item.badge && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 bg-green-50 text-green-600 rounded-full">{item.badge}</span>
                )}
              </div>
              <div className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${item.value ? 'bg-primary-500' : 'bg-gray-300'}`}>
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${item.value ? 'left-4' : 'left-0.5'}`} />
              </div>
            </button>
          ))}
        </div>

        {/* Refer a Guest */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 mb-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[13px] font-semibold text-gray-900">&ldquo;Refer a Guest&rdquo; Feature</h3>
              <p className="text-[12px] text-gray-500 mt-0.5">Allow guests to refer friends and earn rewards through your booking page</p>
            </div>
            <button
              onClick={() => setEnableReferAGuest(!enableReferAGuest)}
              className="shrink-0"
            >
              <div className={`w-9 h-5 rounded-full transition-colors relative ${enableReferAGuest ? 'bg-primary-500' : 'bg-gray-300'}`}>
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${enableReferAGuest ? 'left-4' : 'left-0.5'}`} />
              </div>
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-[12px] text-red-700 font-medium">{error}</p>
          </div>
        )}

        <div className="mt-6 flex justify-between">
          <button
            onClick={onBack}
            className="px-4 py-2 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Back
          </button>
          <button
            onClick={onComplete}
            disabled={saving}
            className="px-8 py-2.5 bg-primary-500 text-white text-[14px] font-semibold rounded-lg hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-2"
          >
            {saving ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Launching...
              </>
            ) : (
              'Launch Property \u2192'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
