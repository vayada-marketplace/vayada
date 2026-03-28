'use client'

import { CheckIcon } from '@heroicons/react/24/outline'

export const PMS_OPTIONS = [
  {
    id: 'vayada',
    name: 'vayada PMS',
    description: 'All-in-one property management system built for independent hotels and villas.',
    available: true,
    badge: 'Recommended',
    features: ['Direct Booking Engine', 'Channel Manager', 'Revenue AI', 'Guest CRM', 'Housekeeping'],
  },
  {
    id: 'cloudbeds',
    name: 'Cloudbeds',
    description: 'Cloud-based hospitality platform for independent hotels and hostels.',
    available: false,
    badge: 'Coming Soon',
    features: ['PMS Integration', 'Channel Manager Sync'],
  },
  {
    id: 'ezee',
    name: 'eZee Absolute',
    description: 'Hotel management software designed for small to mid-size properties.',
    available: false,
    badge: 'Coming Soon',
    features: ['PMS Integration', 'Rate Sync'],
  },
  {
    id: 'siteminder',
    name: 'SiteMinder',
    description: 'Leading hotel channel manager and distribution platform.',
    available: false,
    badge: 'Coming Soon',
    features: ['Channel Distribution', 'Booking Engine'],
  },
]

interface PmsStepProps {
  selectedPms: string
  setSelectedPms: (v: string) => void
  error: string
  canProceed: boolean
  onBack: () => void
  onContinue: () => void
  stepIndicators: React.ReactNode
}

export default function PmsStep({
  selectedPms,
  setSelectedPms,
  error,
  canProceed,
  onBack,
  onContinue,
  stepIndicators,
}: PmsStepProps) {
  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-2xl mx-auto px-6 py-6">
        {stepIndicators}
        <div className="mb-5">
          <h2 className="text-[15px] font-bold text-gray-900">Choose your PMS</h2>
          <p className="text-[12px] text-gray-500 mt-0.5">Select your property management system. You can change this later.</p>
        </div>

        <div className="space-y-3">
          {PMS_OPTIONS.map((pms) => (
            <button
              key={pms.id}
              onClick={() => pms.available && setSelectedPms(pms.id)}
              disabled={!pms.available}
              className={`w-full text-left px-4 py-4 rounded-xl border transition-all ${selectedPms === pms.id
                  ? 'border-primary-500 ring-2 ring-primary-500/20 bg-primary-50/20'
                  : pms.available
                    ? 'border-gray-200 hover:border-gray-300 bg-white'
                    : 'border-gray-100 bg-gray-50/50 opacity-50 cursor-not-allowed'
                }`}
            >
              <div className="flex items-start gap-3.5">
                {/* PMS Icon */}
                <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0">
                  {pms.id === 'vayada' && (
                    <img src="/vayada-logo.png" alt="vayada" className="w-7 h-7 object-contain m-auto" />
                  )}
                  {pms.id === 'cloudbeds' && (
                    <img src="/pms-cloudbeds.png" alt="Cloudbeds" className="w-full h-full object-cover" />
                  )}
                  {pms.id === 'ezee' && (
                    <img src="/pms-ezee.png" alt="eZee" className="w-full h-full object-cover" />
                  )}
                  {pms.id === 'siteminder' && (
                    <img src="/pms-siteminder.png" alt="SiteMinder" className="w-full h-full object-cover" />
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[13px] font-semibold text-gray-900">{pms.name}</span>
                    {pms.badge === 'Recommended' ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                        </svg>
                        Recommended
                      </span>
                    ) : (
                      <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-400">
                        Coming Soon
                      </span>
                    )}
                  </div>
                  <p className="text-[12px] text-gray-500 mb-2">{pms.description}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {pms.features.map((feat) => (
                      <span key={feat} className={`text-[10px] px-2 py-0.5 rounded-full ${pms.available
                          ? 'bg-gray-100 text-gray-600'
                          : 'bg-gray-50 text-gray-400'
                        }`}>
                        {feat}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Selection indicator */}
                {selectedPms === pms.id && (
                  <div className="w-6 h-6 bg-primary-500 rounded-full flex items-center justify-center shrink-0 mt-0.5">
                    <CheckIcon className="w-3.5 h-3.5 text-white" />
                  </div>
                )}
              </div>
            </button>
          ))}
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
            onClick={onContinue}
            disabled={!canProceed}
            className="px-6 py-2 bg-primary-500 text-white text-[13px] font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}
