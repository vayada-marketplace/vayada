'use client'

interface PoliciesStepProps {
  checkInFrom: string; setCheckInFrom: (v: string) => void
  checkInUntil: string; setCheckInUntil: (v: string) => void
  checkOutFrom: string; setCheckOutFrom: (v: string) => void
  checkOutUntil: string; setCheckOutUntil: (v: string) => void
  payAtHotel: boolean; setPayAtHotel: (v: boolean) => void
  payAtHotelMethods: string[]; setPayAtHotelMethods: (v: string[]) => void
  onlineCardPayment: boolean; setOnlineCardPayment: (v: boolean) => void
  bankTransfer: boolean; setBankTransfer: (v: boolean) => void
  payoutAccountHolder: string; setPayoutAccountHolder: (v: string) => void
  payoutIban: string; setPayoutIban: (v: string) => void
  payoutBankName: string; setPayoutBankName: (v: string) => void
  payoutSwift: string; setPayoutSwift: (v: string) => void
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
  checkInFrom, setCheckInFrom,
  checkInUntil, setCheckInUntil,
  checkOutFrom, setCheckOutFrom,
  checkOutUntil, setCheckOutUntil,
  payAtHotel, setPayAtHotel,
  payAtHotelMethods, setPayAtHotelMethods,
  onlineCardPayment, setOnlineCardPayment,
  bankTransfer, setBankTransfer,
  payoutAccountHolder, setPayoutAccountHolder,
  payoutIban, setPayoutIban,
  payoutBankName, setPayoutBankName,
  payoutSwift, setPayoutSwift,
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
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6">
        {stepIndicators}
        <div className="text-center mb-6">
          <h2 className="text-lg font-bold text-gray-900">Policies & Operations</h2>
          <p className="text-[13px] text-gray-500 mt-1">Configure payment methods and guest options</p>
        </div>

        {/* Check-in & Check-out */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 mb-4">
          <h3 className="text-[13px] font-semibold text-gray-900 mb-1">Check-in & Check-out</h3>
          <p className="text-[11px] text-gray-500 mb-3">Set the time windows for guest arrivals and departures.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
            <div>
              <label className="block text-[12px] font-semibold text-gray-700 mb-2">Check-in Period</label>
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <label className="block text-[10px] text-gray-400 mb-0.5">From</label>
                  <input type="time" value={checkInFrom} onChange={(e) => setCheckInFrom(e.target.value)} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent" />
                </div>
                <span className="text-gray-400 mt-4">—</span>
                <div className="flex-1">
                  <label className="block text-[10px] text-gray-400 mb-0.5">Until</label>
                  <input type="time" value={checkInUntil} onChange={(e) => setCheckInUntil(e.target.value)} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent" />
                </div>
              </div>
              <p className="text-[10px] text-gray-400 mt-1">e.g. 14:00 — 22:00</p>
            </div>
            <div>
              <label className="block text-[12px] font-semibold text-gray-700 mb-2">Check-out Period</label>
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <label className="block text-[10px] text-gray-400 mb-0.5">From</label>
                  <input type="time" value={checkOutFrom} onChange={(e) => setCheckOutFrom(e.target.value)} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent" />
                </div>
                <span className="text-gray-400 mt-4">—</span>
                <div className="flex-1">
                  <label className="block text-[10px] text-gray-400 mb-0.5">Until</label>
                  <input type="time" value={checkOutUntil} onChange={(e) => setCheckOutUntil(e.target.value)} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent" />
                </div>
              </div>
              <p className="text-[10px] text-gray-400 mt-1">e.g. 07:00 — 11:00</p>
            </div>
          </div>
        </div>

        {/* Payment Methods */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-3 mb-4">
          <h3 className="text-[13px] font-semibold text-gray-900">Payment Methods</h3>
          <p className="text-[12px] text-gray-500 mb-2">Choose which payment options are available to guests</p>

          {/* Pay at Hotel */}
          <div>
            <button
              onClick={() => setPayAtHotel(!payAtHotel)}
              className={`w-full flex items-center justify-between p-3 rounded-lg border transition-all text-left ${
                payAtHotel
                  ? 'border-primary-500 bg-primary-50/30 ring-1 ring-primary-500'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div>
                <span className="text-[13px] font-medium text-gray-900">Pay at Hotel</span>
                <p className="text-[11px] text-gray-500 mt-0.5">Guests pay upon arrival at the property</p>
              </div>
              <div className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${payAtHotel ? 'bg-primary-500' : 'bg-gray-300'}`}>
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${payAtHotel ? 'left-4' : 'left-0.5'}`} />
              </div>
            </button>
            {payAtHotel && (
              <div className="ml-4 mt-2 flex gap-2">
                {[
                  { key: 'cash', label: 'Cash' },
                  { key: 'card', label: 'Card' },
                ].map((m) => {
                  const selected = payAtHotelMethods.includes(m.key)
                  return (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => {
                        if (selected && payAtHotelMethods.length > 1) {
                          setPayAtHotelMethods(payAtHotelMethods.filter(v => v !== m.key))
                        } else if (!selected) {
                          setPayAtHotelMethods([...payAtHotelMethods, m.key])
                        }
                      }}
                      className={`px-3 py-1.5 text-[12px] font-medium rounded-lg border transition-colors ${
                        selected
                          ? 'border-primary-500 bg-primary-50 text-primary-700'
                          : 'border-gray-200 text-gray-500 hover:border-gray-300'
                      }`}
                    >
                      {m.label}
                    </button>
                  )
                })}
                <span className="text-[11px] text-gray-400 self-center ml-1">
                  {payAtHotelMethods.length === 2 ? 'Cash & Card accepted' : payAtHotelMethods.includes('cash') ? 'Cash only' : 'Card only'}
                </span>
              </div>
            )}
          </div>

          {/* Other payment methods */}
          {[
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

          {/* Payout Details — shown when bank transfer is enabled */}
          {bankTransfer && (
            <div className="mt-3 p-4 bg-gray-50 rounded-lg border border-gray-200 space-y-3">
              <div>
                <h4 className="text-[13px] font-semibold text-gray-900">Payout Details</h4>
                <p className="text-[11px] text-gray-500">Bank account where guests and vayada pay you.</p>
              </div>
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Account Holder Name</label>
                <input type="text" value={payoutAccountHolder} onChange={(e) => setPayoutAccountHolder(e.target.value)} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white" placeholder="e.g. Sunrise Beach Resort Ltd" />
              </div>
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">IBAN</label>
                <input type="text" value={payoutIban} onChange={(e) => setPayoutIban(e.target.value)} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white" placeholder="e.g. GB29 NWBK 6016 1331 9268 19" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Bank Name</label>
                  <input type="text" value={payoutBankName} onChange={(e) => setPayoutBankName(e.target.value)} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white" placeholder="e.g. HSBC Bank" />
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-gray-700 mb-0.5">SWIFT / BIC</label>
                  <input type="text" value={payoutSwift} onChange={(e) => setPayoutSwift(e.target.value)} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white" placeholder="e.g. HBUKGB4B" />
                </div>
              </div>
            </div>
          )}
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
