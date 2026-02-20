'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { authService } from '@/services/auth'
import { roomsService, RoomTypeCreate } from '@/services/rooms'
import { checkPmsSetupStatus } from '@/lib/utils/setupStatus'

const STEPS = [
  { number: 1, label: 'Your First Room' },
  { number: 2, label: 'Room Details' },
  { number: 3, label: 'Review & Complete' },
]

export default function PmsSetupPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [step, setStep] = useState(1)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Step 1: Basic Info
  const [roomName, setRoomName] = useState('')
  const [bedType, setBedType] = useState('')
  const [baseRate, setBaseRate] = useState(0)
  const [currency, setCurrency] = useState('EUR')
  const [maxOccupancy, setMaxOccupancy] = useState(2)
  const [size, setSize] = useState(0)
  const [totalRooms, setTotalRooms] = useState(1)

  // Step 2: Details
  const [shortDescription, setShortDescription] = useState('')
  const [description, setDescription] = useState('')
  const [amenities, setAmenities] = useState<string[]>([])
  const [features, setFeatures] = useState<string[]>([])
  const [images, setImages] = useState<string[]>([])
  const [amenityInput, setAmenityInput] = useState('')
  const [featureInput, setFeatureInput] = useState('')
  const [imageInput, setImageInput] = useState('')

  useEffect(() => {
    async function checkAuth() {
      if (!authService.isLoggedIn() || !authService.isHotelAdmin()) {
        router.replace('/login')
        return
      }
      const status = await checkPmsSetupStatus()
      if (!status || !status.registered) {
        router.replace('/login')
        return
      }
      if (status.setupComplete) {
        localStorage.setItem('pmsSetupComplete', 'true')
        router.replace('/dashboard')
        return
      }
      setLoading(false)
    }
    checkAuth()
  }, [router])

  const canProceed = (): boolean => {
    if (step === 1) {
      return !!(roomName.trim() && baseRate > 0 && totalRooms >= 1)
    }
    return true
  }

  const addToList = (
    list: string[],
    setList: (v: string[]) => void,
    value: string,
    setter: (v: string) => void
  ) => {
    if (!value.trim()) return
    setList([...list, value.trim()])
    setter('')
  }

  const removeFromList = (
    list: string[],
    setList: (v: string[]) => void,
    index: number
  ) => {
    const newList = [...list]
    newList.splice(index, 1)
    setList(newList)
  }

  const handleComplete = async () => {
    setError('')
    setSaving(true)
    try {
      const data: RoomTypeCreate = {
        name: roomName,
        bedType,
        baseRate,
        currency,
        maxOccupancy,
        size,
        totalRooms,
        shortDescription,
        description,
        amenities,
        features,
        images,
        isActive: true,
        sortOrder: 0,
      }
      await roomsService.create(data)
      localStorage.setItem('pmsSetupComplete', 'true')
      router.push('/dashboard')
    } catch {
      setError('Failed to create room type. Please try again.')
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Top bar */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 shrink-0">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7" />
                <path d="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
                <path d="M3 7h18" />
                <path d="M8 11h8" />
              </svg>
            </div>
            <span className="font-semibold text-gray-900 text-[15px]">PMS Setup</span>
          </div>
          <div className="flex items-center gap-2">
            {STEPS.map((s, idx) => (
              <div key={s.number} className="flex items-center">
                <div className="flex items-center gap-1.5">
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold transition-colors ${
                      step >= s.number
                        ? 'bg-primary-500 text-white'
                        : 'bg-gray-200 text-gray-500'
                    }`}
                  >
                    {step > s.number ? (
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      s.number
                    )}
                  </div>
                  <span className={`text-[12px] font-medium ${step >= s.number ? 'text-gray-900' : 'text-gray-400'}`}>
                    {s.label}
                  </span>
                </div>
                {idx < STEPS.length - 1 && (
                  <div className={`w-10 h-px mx-2 ${step > s.number ? 'bg-primary-500' : 'bg-gray-200'}`} />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="bg-white border-b border-gray-100 shrink-0">
        <div className="max-w-3xl mx-auto">
          <div className="h-1 bg-gray-100">
            <div
              className="h-full bg-primary-500 transition-all duration-300"
              style={{ width: `${(step / 3) * 100}%` }}
            />
          </div>
        </div>
      </div>

      {/* Step 1: Your First Room */}
      {step === 1 && (
        <div className="flex-1 overflow-auto">
          <div className="max-w-2xl mx-auto px-6 py-6">
            <div className="text-center mb-6">
              <h2 className="text-lg font-bold text-gray-900">Your First Room</h2>
              <p className="text-[13px] text-gray-500 mt-1">Set up basic information for your first room type</p>
            </div>

            <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
              <div>
                <label className="block text-[13px] font-medium text-gray-700 mb-1">
                  Room Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900"
                  placeholder="e.g. Deluxe Mountain View"
                />
              </div>

              <div>
                <label className="block text-[13px] font-medium text-gray-700 mb-1">Bed Type</label>
                <input
                  type="text"
                  value={bedType}
                  onChange={(e) => setBedType(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900"
                  placeholder="e.g. King Bed"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[13px] font-medium text-gray-700 mb-1">
                    Base Rate <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={baseRate || ''}
                    onChange={(e) => setBaseRate(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900"
                    placeholder="120.00"
                  />
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-gray-700 mb-1">Currency</label>
                  <input
                    type="text"
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                    maxLength={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[13px] font-medium text-gray-700 mb-1">Max Occupancy</label>
                  <input
                    type="number"
                    value={maxOccupancy}
                    onChange={(e) => setMaxOccupancy(parseInt(e.target.value) || 1)}
                    min={1}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900"
                  />
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-gray-700 mb-1">Size (m&sup2;)</label>
                  <input
                    type="number"
                    value={size || ''}
                    onChange={(e) => setSize(parseInt(e.target.value) || 0)}
                    min={0}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900"
                    placeholder="32"
                  />
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-gray-700 mb-1">
                    Total Rooms <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    value={totalRooms}
                    onChange={(e) => setTotalRooms(parseInt(e.target.value) || 1)}
                    min={1}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900"
                  />
                </div>
              </div>
            </div>

            {error && (
              <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-[12px] text-red-700 font-medium">{error}</p>
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <button
                onClick={() => { setError(''); setStep(2) }}
                disabled={!canProceed()}
                className="px-6 py-2 bg-primary-500 text-white text-[13px] font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step 2: Room Details */}
      {step === 2 && (
        <div className="flex-1 overflow-auto">
          <div className="max-w-2xl mx-auto px-6 py-6">
            <div className="text-center mb-6">
              <h2 className="text-lg font-bold text-gray-900">Room Details</h2>
              <p className="text-[13px] text-gray-500 mt-1">Add descriptions, amenities, and images for your room</p>
            </div>

            <div className="space-y-4">
              {/* Descriptions */}
              <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
                <div>
                  <label className="block text-[13px] font-medium text-gray-700 mb-1">Short Description</label>
                  <input
                    type="text"
                    value={shortDescription}
                    onChange={(e) => setShortDescription(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900"
                    placeholder="Brief one-liner for listings"
                  />
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-gray-700 mb-1">Full Description</label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900 resize-y"
                    placeholder="Detailed description for the room page"
                  />
                </div>
              </div>

              {/* Amenities */}
              <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-3">
                <label className="block text-[13px] font-medium text-gray-700">Amenities</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={amenityInput}
                    onChange={(e) => setAmenityInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addToList(amenities, setAmenities, amenityInput, setAmenityInput))}
                    placeholder="e.g. Free WiFi, Air Conditioning"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  <button
                    type="button"
                    onClick={() => addToList(amenities, setAmenities, amenityInput, setAmenityInput)}
                    className="px-3 py-2 bg-gray-100 text-gray-700 text-[13px] rounded-lg hover:bg-gray-200"
                  >
                    Add
                  </button>
                </div>
                {amenities.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {amenities.map((a, i) => (
                      <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-100 text-gray-700 text-[12px] rounded-full">
                        {a}
                        <button onClick={() => removeFromList(amenities, setAmenities, i)} className="text-gray-400 hover:text-gray-600">&times;</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Features */}
              <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-3">
                <label className="block text-[13px] font-medium text-gray-700">Features</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={featureInput}
                    onChange={(e) => setFeatureInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addToList(features, setFeatures, featureInput, setFeatureInput))}
                    placeholder="e.g. Mountain View, Balcony"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  <button
                    type="button"
                    onClick={() => addToList(features, setFeatures, featureInput, setFeatureInput)}
                    className="px-3 py-2 bg-gray-100 text-gray-700 text-[13px] rounded-lg hover:bg-gray-200"
                  >
                    Add
                  </button>
                </div>
                {features.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {features.map((f, i) => (
                      <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-100 text-gray-700 text-[12px] rounded-full">
                        {f}
                        <button onClick={() => removeFromList(features, setFeatures, i)} className="text-gray-400 hover:text-gray-600">&times;</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Images */}
              <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-3">
                <label className="block text-[13px] font-medium text-gray-700">Images (URLs)</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={imageInput}
                    onChange={(e) => setImageInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addToList(images, setImages, imageInput, setImageInput))}
                    placeholder="https://example.com/room.jpg"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  <button
                    type="button"
                    onClick={() => addToList(images, setImages, imageInput, setImageInput)}
                    className="px-3 py-2 bg-gray-100 text-gray-700 text-[13px] rounded-lg hover:bg-gray-200"
                  >
                    Add
                  </button>
                </div>
                {images.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {images.map((img, i) => (
                      <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-100 text-gray-700 text-[12px] rounded-full max-w-xs truncate">
                        {img}
                        <button onClick={() => removeFromList(images, setImages, i)} className="text-gray-400 hover:text-gray-600 shrink-0">&times;</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {error && (
              <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-[12px] text-red-700 font-medium">{error}</p>
              </div>
            )}

            <div className="mt-6 flex justify-between">
              <button
                onClick={() => setStep(1)}
                className="px-4 py-2 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => { setError(''); setStep(3) }}
                className="px-6 py-2 bg-primary-500 text-white text-[13px] font-medium rounded-lg hover:bg-primary-600 transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step 3: Review & Complete */}
      {step === 3 && (
        <div className="flex-1 overflow-auto">
          <div className="max-w-2xl mx-auto px-6 py-6">
            <div className="text-center mb-6">
              <h2 className="text-lg font-bold text-gray-900">Review & Complete</h2>
              <p className="text-[13px] text-gray-500 mt-1">Review your room type before creating it</p>
            </div>

            {/* Preview Card */}
            <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-base font-bold text-gray-900">{roomName}</h3>
                  {bedType && <p className="text-[13px] text-gray-500 mt-0.5">{bedType}</p>}
                </div>
                <div className="text-right">
                  <p className="text-lg font-bold text-gray-900">{currency} {baseRate.toFixed(2)}</p>
                  <p className="text-[12px] text-gray-500">per night</p>
                </div>
              </div>

              {shortDescription && (
                <p className="text-[13px] text-gray-600 italic">{shortDescription}</p>
              )}

              {description && (
                <p className="text-[13px] text-gray-600">{description}</p>
              )}

              <div className="grid grid-cols-3 gap-3 pt-2 border-t border-gray-100">
                <div>
                  <p className="text-[11px] text-gray-500 uppercase tracking-wider">Occupancy</p>
                  <p className="text-[13px] font-medium text-gray-900">{maxOccupancy} guests</p>
                </div>
                <div>
                  <p className="text-[11px] text-gray-500 uppercase tracking-wider">Size</p>
                  <p className="text-[13px] font-medium text-gray-900">{size > 0 ? `${size} m\u00B2` : '-'}</p>
                </div>
                <div>
                  <p className="text-[11px] text-gray-500 uppercase tracking-wider">Total Rooms</p>
                  <p className="text-[13px] font-medium text-gray-900">{totalRooms}</p>
                </div>
              </div>

              {amenities.length > 0 && (
                <div className="pt-2 border-t border-gray-100">
                  <p className="text-[11px] text-gray-500 uppercase tracking-wider mb-1.5">Amenities</p>
                  <div className="flex flex-wrap gap-1.5">
                    {amenities.map((a, i) => (
                      <span key={i} className="px-2 py-0.5 bg-primary-50 text-primary-700 text-[12px] rounded-full">{a}</span>
                    ))}
                  </div>
                </div>
              )}

              {features.length > 0 && (
                <div className="pt-2 border-t border-gray-100">
                  <p className="text-[11px] text-gray-500 uppercase tracking-wider mb-1.5">Features</p>
                  <div className="flex flex-wrap gap-1.5">
                    {features.map((f, i) => (
                      <span key={i} className="px-2 py-0.5 bg-gray-100 text-gray-700 text-[12px] rounded-full">{f}</span>
                    ))}
                  </div>
                </div>
              )}

              {images.length > 0 && (
                <div className="pt-2 border-t border-gray-100">
                  <p className="text-[11px] text-gray-500 uppercase tracking-wider mb-1.5">Images</p>
                  <p className="text-[12px] text-gray-600">{images.length} image{images.length !== 1 ? 's' : ''} added</p>
                </div>
              )}
            </div>

            {error && (
              <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-[12px] text-red-700 font-medium">{error}</p>
              </div>
            )}

            <div className="mt-6 flex justify-between">
              <button
                onClick={() => setStep(2)}
                className="px-4 py-2 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleComplete}
                disabled={saving}
                className="inline-flex items-center justify-center gap-1.5 px-6 py-2 bg-primary-500 text-white text-[13px] font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Creating Room...
                  </>
                ) : (
                  'Complete Setup'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
