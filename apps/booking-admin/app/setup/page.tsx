'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { authService } from '@/services/auth'
import { settingsService } from '@/services/settings'
import { pmsClient } from '@/services/api/pmsClient'
import { checkSetupStatus, isSetupComplete } from '@/lib/utils/setupStatus'
import { FONT_PAIRINGS } from '@/lib/constants/branding'
import { CheckIcon } from '@heroicons/react/24/outline'
import { uploadSingleImage, uploadImages } from '@/lib/utils/uploadImage'

import PropertyStep from '@/components/setup/PropertyStep'
import BrandMediaStep from '@/components/setup/BrandMediaStep'
import PmsStep from '@/components/setup/PmsStep'
import RoomsStep, { type RoomType, createEmptyRoom } from '@/components/setup/RoomsStep'
import PoliciesStep from '@/components/setup/PoliciesStep'

const GOOGLE_FONTS_URL = 'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Source+Sans+Pro:wght@300;400;600;700&family=Inter:wght@300;400;500;600;700&family=Cormorant+Garamond:ital,wght@0,400;0,700;1,400&family=Lato:wght@300;400;700&display=swap'

const STEPS = [
  { number: 1, label: 'Your Property' },
  { number: 2, label: 'Brand & Media' },
  { number: 3, label: 'Choose PMS' },
  { number: 4, label: 'Rooms & Rates' },
  { number: 5, label: 'Policies' },
]

type RoomTab = 'details' | 'pricing' | 'media' | 'benefits'

export default function SetupPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [step, setStep] = useState(1)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [prefilled, setPrefilled] = useState(false)

  // Step 1: Your Property
  const [propertyName, setPropertyName] = useState('')
  const [city, setCity] = useState('')
  const [country, setCountry] = useState('')
  const [address, setAddress] = useState('')
  const [reservationEmail, setReservationEmail] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [whatsapp, setWhatsapp] = useState('')
  const [instagram, setInstagram] = useState('')
  const [facebook, setFacebook] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [defaultLanguage, setDefaultLanguage] = useState('en')
  const [supportedCurrencies, setSupportedCurrencies] = useState<string[]>([])
  const [supportedLanguages, setSupportedLanguages] = useState<string[]>([])

  // Step 2: Brand & Media
  const [heroImage, setHeroImage] = useState('')
  const [primaryColor, setPrimaryColor] = useState('#4F46E5')
  const [accentColor, setAccentColor] = useState('#F5F3EF')
  const [selectedFont, setSelectedFont] = useState('high-end-serif')
  const [propertyDescription, setPropertyDescription] = useState('')
  const [bookingFilters, setBookingFilters] = useState<string[]>(['includeBreakfast', 'freeCancellation', 'payAtHotel', 'bestRated', 'mountainView'])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  // Step 3: Choose PMS
  const [selectedPms, setSelectedPms] = useState('vayada')

  // Step 4: Rooms & Rates
  const [rooms, setRooms] = useState<RoomType[]>([createEmptyRoom()])
  const [activeRoomIndex, setActiveRoomIndex] = useState(0)
  const [activeRoomTab, setActiveRoomTab] = useState<RoomTab>('details')
  const [amenityInput, setAmenityInput] = useState('')
  const [featureInput, setFeatureInput] = useState('')
  const [benefitInput, setBenefitInput] = useState('')
  const roomFileInputRef = useRef<HTMLInputElement>(null)
  const [uploadingRoomImages, setUploadingRoomImages] = useState(false)

  // Step 5: Policies & Operations
  const [checkInTime, setCheckInTime] = useState('14:00')
  const [checkOutTime, setCheckOutTime] = useState('11:00')
  const [minimumStay, setMinimumStay] = useState(1)
  const [payAtHotel, setPayAtHotel] = useState(true)
  const [onlineCardPayment, setOnlineCardPayment] = useState(false)
  const [bankTransfer, setBankTransfer] = useState(false)
  const [specialRequests, setSpecialRequests] = useState(true)
  const [estimatedArrivalTime, setEstimatedArrivalTime] = useState(false)
  const [numberOfGuests, setNumberOfGuests] = useState(false)
  const [enableReferAGuest, setEnableReferAGuest] = useState(false)

  useEffect(() => {
    async function checkAuth() {
      if (!authService.isLoggedIn() || !authService.isHotelAdmin()) {
        router.replace('/login')
        return
      }
      const status = await checkSetupStatus()
      if (status?.setup_complete) {
        localStorage.setItem('setupComplete', 'true')
        router.replace('/dashboard')
        return
      }
      const prefill = status?.prefill_data
      if (prefill) {
        if (prefill.property_name) setPropertyName(prefill.property_name)
        if (prefill.reservation_email) setReservationEmail(prefill.reservation_email)
        if (prefill.phone_number) setPhoneNumber(prefill.phone_number)
        if (prefill.address) setAddress(prefill.address)
        if (prefill.hero_image) setHeroImage(prefill.hero_image)
        setPrefilled(true)
      }
      setLoading(false)
    }
    checkAuth()
  }, [router])

  // Default room currency to property currency
  useEffect(() => {
    setRooms(prev => prev.map(r => r.currency ? r : { ...r, currency }))
  }, [currency])

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const previewUrl = URL.createObjectURL(file)
    setHeroImage(previewUrl)
    try {
      setUploading(true)
      const s3Url = await uploadSingleImage(file)
      URL.revokeObjectURL(previewUrl)
      setHeroImage(s3Url)
    } catch (err) {
      console.error('Image upload failed:', err)
    } finally {
      setUploading(false)
    }
  }

  const handleRoomImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    const room = rooms[activeRoomIndex]
    try {
      setUploadingRoomImages(true)
      const urls = await uploadImages(Array.from(files))
      setRooms(prev => prev.map((r, i) => i === activeRoomIndex ? { ...r, images: [...r.images, ...urls] } : r))
    } catch (err) {
      console.error('Room image upload failed:', err)
    } finally {
      setUploadingRoomImages(false)
      if (roomFileInputRef.current) roomFileInputRef.current.value = ''
    }
  }

  const canProceed = (): boolean => {
    if (step === 1) {
      return !!(propertyName.trim() && city.trim() && country && address.trim() && reservationEmail.trim() && phoneNumber.trim())
    }
    if (step === 2) {
      return !!(primaryColor && accentColor && selectedFont && heroImage.trim())
    }
    if (step === 3) {
      return !!selectedPms
    }
    if (step === 4) {
      return rooms.every(r => !!(r.name.trim() && r.maxOccupancy >= 1 && r.totalRooms >= 1))
    }
    if (step === 5) {
      return true
    }
    return false
  }

  const handleComplete = async () => {
    setError('')
    setSaving(true)
    try {
      // 1. Save property settings
      await settingsService.updatePropertySettings({
        property_name: propertyName,
        reservation_email: reservationEmail,
        phone_number: phoneNumber,
        whatsapp_number: whatsapp,
        address,
        city,
        country,
        instagram,
        facebook,
        default_currency: currency,
        default_language: defaultLanguage,
        supported_currencies: supportedCurrencies,
        supported_languages: supportedLanguages,
        check_in_time: checkInTime,
        check_out_time: checkOutTime,
        minimum_stay: minimumStay,
        pay_at_property_enabled: payAtHotel,
        online_card_payment: onlineCardPayment,
        bank_transfer: bankTransfer,
        special_requests_enabled: specialRequests,
        arrival_time_enabled: estimatedArrivalTime,
        guest_count_enabled: numberOfGuests,
        refer_a_guest_enabled: enableReferAGuest,
      })

      // 2. Save design settings
      await settingsService.updateDesignSettings({
        primary_color: primaryColor,
        accent_color: accentColor,
        font_pairing: selectedFont,
        hero_image: heroImage,
        hero_subtext: propertyDescription,
        booking_filters: bookingFilters,
      })

      // 3. Register hotel in PMS
      if (selectedPms === 'vayada') {
        const slug = propertyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        try {
          await pmsClient.post('/admin/register-hotel', {
            name: propertyName,
            slug,
            contactEmail: reservationEmail,
          })
        } catch {
          // Non-fatal: hotel may already be registered (idempotent)
        }
        localStorage.setItem('pmsProvider', 'vayada')

        // 4. Create room types
        for (const r of rooms) {
          try {
            const bedSummary = r.beds.map((b) => `${b.count} ${b.type}`).join(', ')
            await pmsClient.post('/admin/room-types', {
              name: r.name,
              bedType: bedSummary,
              maxOccupancy: r.maxOccupancy,
              bedrooms: r.bedrooms,
              bathrooms: r.bathrooms,
              size: r.roomSize ? Number(r.roomSize) : 0,
              totalRooms: r.totalRooms,
              description: r.description,
              baseRate: Number(r.baseRate),
              nonRefundableRate: r.nonRefundableRate ? Number(r.nonRefundableRate) : undefined,
              currency: r.currency || currency,
              images: r.images,
              amenities: r.amenities,
              features: r.features,
            })
          } catch {
            // Non-fatal: room creation may fail but setup can continue
          }
        }

        // 5. Save payment settings
        try {
          await pmsClient.patch('/admin/payment-settings', {
            payAtPropertyEnabled: payAtHotel,
          })
        } catch {
          // Non-fatal
        }
      }

      // Auto-select the newly created hotel
      const hotelList = await settingsService.listHotels()
      if (hotelList.length > 0) {
        const newHotel = hotelList[hotelList.length - 1]
        localStorage.setItem('selectedHotelId', newHotel.id)
      }

      const complete = await isSetupComplete()
      if (complete) {
        localStorage.setItem('setupComplete', 'true')
        router.push('/dashboard')
      } else {
        // Force redirect anyway — the backend may not have updated yet
        localStorage.setItem('setupComplete', 'true')
        router.push('/dashboard')
      }
    } catch {
      setError('Failed to save settings. Please try again.')
      setSaving(false)
    }
  }

  const stepIndicators = (
    <div className="flex items-center justify-center mb-8">
      {STEPS.map((s, idx) => (
        <div key={s.number} className="flex items-center">
          <div className="flex items-center gap-1.5 shrink-0">
            <div
              className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold transition-colors shrink-0 ${
                step > s.number
                  ? 'bg-primary-500 text-white'
                  : step === s.number
                    ? 'bg-primary-500 text-white'
                    : 'bg-gray-200 text-gray-500'
              }`}
            >
              {step > s.number ? (
                <CheckIcon className="w-3.5 h-3.5" />
              ) : (
                s.number
              )}
            </div>
            <span className={`text-[12px] font-medium whitespace-nowrap ${
              step >= s.number ? 'text-gray-900' : 'text-gray-400'
            }`}>
              {s.label}
            </span>
          </div>
          {idx < STEPS.length - 1 && (
            <div className={`w-12 h-px mx-3 shrink-0 ${step > s.number ? 'bg-primary-500' : 'bg-gray-300'}`} />
          )}
        </div>
      ))}
    </div>
  )

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="stylesheet" href={GOOGLE_FONTS_URL} />

      {/* Top bar */}
      <div className="bg-white border-b border-gray-200 px-8 py-3 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect width="32" height="32" rx="6" fill="#4338CA" />
              <path d="M10 16.5L14 20.5L22 12.5" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="font-semibold text-gray-900 text-[15px]">Property Setup</span>
          </div>
          <span className="text-[13px] text-gray-500">Step {step} of 5</span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-[3px] bg-gray-100 shrink-0">
        <div
          className="h-full bg-primary-600 transition-all duration-300"
          style={{ width: `${(step / 5) * 100}%` }}
        />
      </div>

      {step === 1 && (
        <PropertyStep
          propertyName={propertyName} setPropertyName={setPropertyName}
          city={city} setCity={setCity}
          country={country} setCountry={setCountry}
          address={address} setAddress={setAddress}
          reservationEmail={reservationEmail} setReservationEmail={setReservationEmail}
          phoneNumber={phoneNumber} setPhoneNumber={setPhoneNumber}
          whatsapp={whatsapp} setWhatsapp={setWhatsapp}
          instagram={instagram} setInstagram={setInstagram}
          facebook={facebook} setFacebook={setFacebook}
          currency={currency} setCurrency={setCurrency}
          defaultLanguage={defaultLanguage} setDefaultLanguage={setDefaultLanguage}
          supportedCurrencies={supportedCurrencies} setSupportedCurrencies={setSupportedCurrencies}
          supportedLanguages={supportedLanguages} setSupportedLanguages={setSupportedLanguages}
          prefilled={prefilled}
          error={error}
          canProceed={canProceed()}
          onContinue={() => { setError(''); setStep(2) }}
          stepIndicators={stepIndicators}
        />
      )}

      {step === 2 && (
        <BrandMediaStep
          heroImage={heroImage} setHeroImage={setHeroImage}
          primaryColor={primaryColor} setPrimaryColor={setPrimaryColor}
          accentColor={accentColor} setAccentColor={setAccentColor}
          selectedFont={selectedFont} setSelectedFont={setSelectedFont}
          propertyDescription={propertyDescription} setPropertyDescription={setPropertyDescription}
          uploading={uploading}
          fileInputRef={fileInputRef}
          handleImageUpload={handleImageUpload}
          propertyName={propertyName}
          currency={currency}
          defaultLanguage={defaultLanguage}
          error={error}
          canProceed={canProceed()}
          onBack={() => setStep(1)}
          onContinue={() => { setError(''); setStep(3) }}
          stepIndicators={stepIndicators}
        />
      )}

      {step === 3 && (
        <PmsStep
          selectedPms={selectedPms}
          setSelectedPms={setSelectedPms}
          error={error}
          canProceed={canProceed()}
          onBack={() => setStep(2)}
          onContinue={() => { setError(''); setStep(4) }}
          stepIndicators={stepIndicators}
        />
      )}

      {step === 4 && (
        <RoomsStep
          rooms={rooms}
          setRooms={setRooms}
          activeRoomIndex={activeRoomIndex}
          setActiveRoomIndex={setActiveRoomIndex}
          activeRoomTab={activeRoomTab}
          setActiveRoomTab={setActiveRoomTab}
          amenityInput={amenityInput} setAmenityInput={setAmenityInput}
          featureInput={featureInput} setFeatureInput={setFeatureInput}
          benefitInput={benefitInput} setBenefitInput={setBenefitInput}
          roomFileInputRef={roomFileInputRef}
          uploadingRoomImages={uploadingRoomImages}
          handleRoomImageUpload={handleRoomImageUpload}
          currency={currency}
          error={error}
          canProceed={canProceed()}
          onBack={() => setStep(3)}
          onContinue={() => { setError(''); setStep(5) }}
          stepIndicators={stepIndicators}
        />
      )}

      {step === 5 && (
        <PoliciesStep
          checkInTime={checkInTime} setCheckInTime={setCheckInTime}
          checkOutTime={checkOutTime} setCheckOutTime={setCheckOutTime}
          minimumStay={minimumStay} setMinimumStay={setMinimumStay}
          payAtHotel={payAtHotel} setPayAtHotel={setPayAtHotel}
          onlineCardPayment={onlineCardPayment} setOnlineCardPayment={setOnlineCardPayment}
          bankTransfer={bankTransfer} setBankTransfer={setBankTransfer}
          specialRequests={specialRequests} setSpecialRequests={setSpecialRequests}
          estimatedArrivalTime={estimatedArrivalTime} setEstimatedArrivalTime={setEstimatedArrivalTime}
          numberOfGuests={numberOfGuests} setNumberOfGuests={setNumberOfGuests}
          enableReferAGuest={enableReferAGuest} setEnableReferAGuest={setEnableReferAGuest}
          error={error}
          saving={saving}
          onBack={() => setStep(4)}
          onComplete={handleComplete}
          stepIndicators={stepIndicators}
        />
      )}
    </div>
  )
}
