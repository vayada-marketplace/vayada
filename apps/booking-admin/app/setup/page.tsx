'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { authService } from '@/services/auth'
import { settingsService } from '@/services/settings'
import { pmsClient } from '@/services/api/pmsClient'
import { checkSetupStatus, isSetupComplete } from '@/lib/utils/setupStatus'
import { COLOR_PRESETS, FONT_PAIRINGS } from '@/lib/constants/branding'
import { CURRENCY_OPTIONS } from '@/lib/constants/options'
import { PhotoIcon, XMarkIcon, CheckIcon, PlusIcon } from '@heroicons/react/24/outline'

const AVAILABLE_FILTERS = [
  { key: 'includeBreakfast', label: 'Include Breakfast' },
  { key: 'freeCancellation', label: 'Free Cancellation' },
  { key: 'payAtHotel', label: 'Pay at Hotel' },
  { key: 'bestRated', label: 'Best Rated' },
  { key: 'mountainView', label: 'Mountain View' },
]

const GOOGLE_FONTS_URL = 'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Source+Sans+Pro:wght@300;400;600;700&family=Inter:wght@300;400;500;600;700&family=Cormorant+Garamond:ital,wght@0,400;0,700;1,400&family=Lato:wght@300;400;700&display=swap'

const STEPS = [
  { number: 1, label: 'Your Property' },
  { number: 2, label: 'Brand & Media' },
  { number: 3, label: 'Choose PMS' },
  { number: 4, label: 'Rooms & Rates' },
  { number: 5, label: 'Policies' },
]

const PMS_OPTIONS = [
  {
    id: 'vayada',
    name: 'Vayada PMS',
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

type RoomTab = 'details' | 'pricing' | 'media' | 'benefits'
const ROOM_TABS: { key: RoomTab; label: string }[] = [
  { key: 'details', label: 'Room Details' },
  { key: 'pricing', label: 'Pricing & Rates' },
  { key: 'media', label: 'Images & Amenities' },
  { key: 'benefits', label: 'Book Direct Benefits' },
]

const BED_TYPES = ['King Bed', 'Queen Bed', 'Double Bed', 'Twin Beds', 'Single Bed', 'Bunk Bed', 'Sofa Bed']

const ROOM_CATEGORIES = ['Standard', 'Deluxe', 'Superior', 'Suite', 'Villa', 'Bungalow', 'Studio', 'Penthouse']

const QUICK_AMENITIES = [
  { label: 'Private Pool', emoji: '\uD83C\uDFCA' },
  { label: 'Entire villa', emoji: '\uD83C\uDFE1' },
  { label: 'Free WiFi', emoji: '\uD83D\uDCF6' },
  { label: 'Air conditioning', emoji: '\u2744\uFE0F' },
  { label: 'Pool view', emoji: '\uD83C\uDFCA' },
  { label: 'Ocean view', emoji: '\uD83C\uDFD6\uFE0F' },
  { label: 'Mountain view', emoji: '\u26F0\uFE0F' },
  { label: 'Kitchen', emoji: '\uD83C\uDF73' },
  { label: 'Flat-screen TV', emoji: '\uD83D\uDCFA' },
  { label: 'Garden', emoji: '\uD83C\uDF3F' },
  { label: 'Spa bath', emoji: '\uD83D\uDEC1' },
  { label: 'Parking', emoji: '\uD83C\uDD7F\uFE0F' },
]

const BENEFIT_OPTIONS = [
  'Welcome Drink on Arrival',
  '10% Spa Discount',
  'Late Check-out (subject to availability)',
  'Early Check-in (subject to availability)',
  'Free Airport Transfer',
  'Daily Breakfast Included',
  'Room Upgrade (subject to availability)',
]

const COUNTRY_OPTIONS = [
  'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Argentina', 'Armenia', 'Australia',
  'Austria', 'Azerbaijan', 'Bahamas', 'Bahrain', 'Bangladesh', 'Barbados', 'Belarus', 'Belgium',
  'Belize', 'Benin', 'Bhutan', 'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Brunei',
  'Bulgaria', 'Burkina Faso', 'Burundi', 'Cambodia', 'Cameroon', 'Canada', 'Cape Verde',
  'Central African Republic', 'Chad', 'Chile', 'China', 'Colombia', 'Comoros', 'Congo',
  'Costa Rica', 'Croatia', 'Cuba', 'Cyprus', 'Czech Republic', 'Denmark', 'Djibouti', 'Dominica',
  'Dominican Republic', 'East Timor', 'Ecuador', 'Egypt', 'El Salvador', 'Equatorial Guinea',
  'Eritrea', 'Estonia', 'Eswatini', 'Ethiopia', 'Fiji', 'Finland', 'France', 'Gabon', 'Gambia',
  'Georgia', 'Germany', 'Ghana', 'Greece', 'Grenada', 'Guatemala', 'Guinea', 'Guinea-Bissau',
  'Guyana', 'Haiti', 'Honduras', 'Hungary', 'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq',
  'Ireland', 'Israel', 'Italy', 'Jamaica', 'Japan', 'Jordan', 'Kazakhstan', 'Kenya', 'Kiribati',
  'Kosovo', 'Kuwait', 'Kyrgyzstan', 'Laos', 'Latvia', 'Lebanon', 'Lesotho', 'Liberia', 'Libya',
  'Liechtenstein', 'Lithuania', 'Luxembourg', 'Madagascar', 'Malawi', 'Malaysia', 'Maldives',
  'Mali', 'Malta', 'Marshall Islands', 'Mauritania', 'Mauritius', 'Mexico', 'Micronesia',
  'Moldova', 'Monaco', 'Mongolia', 'Montenegro', 'Morocco', 'Mozambique', 'Myanmar', 'Namibia',
  'Nauru', 'Nepal', 'Netherlands', 'New Zealand', 'Nicaragua', 'Niger', 'Nigeria', 'North Korea',
  'North Macedonia', 'Norway', 'Oman', 'Pakistan', 'Palau', 'Palestine', 'Panama',
  'Papua New Guinea', 'Paraguay', 'Peru', 'Philippines', 'Poland', 'Portugal', 'Qatar', 'Romania',
  'Russia', 'Rwanda', 'Saint Kitts and Nevis', 'Saint Lucia', 'Saint Vincent and the Grenadines',
  'Samoa', 'San Marino', 'Saudi Arabia', 'Senegal', 'Serbia', 'Seychelles', 'Sierra Leone',
  'Singapore', 'Slovakia', 'Slovenia', 'Solomon Islands', 'Somalia', 'South Africa', 'South Korea',
  'South Sudan', 'Spain', 'Sri Lanka', 'Sudan', 'Suriname', 'Sweden', 'Switzerland', 'Syria',
  'Taiwan', 'Tajikistan', 'Tanzania', 'Thailand', 'Togo', 'Tonga', 'Trinidad and Tobago',
  'Tunisia', 'Turkey', 'Turkmenistan', 'Tuvalu', 'Uganda', 'Ukraine', 'United Arab Emirates',
  'United Kingdom', 'United States', 'Uruguay', 'Uzbekistan', 'Vanuatu', 'Vatican City',
  'Venezuela', 'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe',
]

const LANGUAGE_OPTIONS = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'German' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' },
  { code: 'id', label: 'Indonesian' },
]

const TIME_OPTIONS = Array.from({ length: 24 }, (_, i) => {
  const h = i.toString().padStart(2, '0')
  return { value: `${h}:00`, label: `${h}:00` }
})

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
  const [activeRoomTab, setActiveRoomTab] = useState<RoomTab>('details')
  const [roomName, setRoomName] = useState('')
  const [beds, setBeds] = useState<{ type: string; count: number }[]>([{ type: 'King Bed', count: 1 }])
  const [maxOccupancy, setMaxOccupancy] = useState(2)
  const [roomSize, setRoomSize] = useState('')
  const [totalRooms, setTotalRooms] = useState(1)
  const [roomDescription, setRoomDescription] = useState('')
  const [roomCategory, setRoomCategory] = useState('')
  const [baseRate, setBaseRate] = useState('')
  const [nonRefundableRate, setNonRefundableRate] = useState('')
  const [freeCancellationDays, setFreeCancellationDays] = useState('7 days before')
  const [availabilityNote, setAvailabilityNote] = useState('')
  const [roomCurrency, setRoomCurrency] = useState('')
  const [roomImages, setRoomImages] = useState<string[]>([])
  const [amenities, setAmenities] = useState<string[]>([])
  const [features, setFeatures] = useState<string[]>([])
  const [bookDirectBenefits, setBookDirectBenefits] = useState<string[]>([])
  const [filterInput, setFilterInput] = useState('')
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
    if (!roomCurrency) setRoomCurrency(currency)
  }, [currency, roomCurrency])

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const previewUrl = URL.createObjectURL(file)
    setHeroImage(previewUrl)
    try {
      setUploading(true)
      const pmsUrl = process.env.NEXT_PUBLIC_PMS_URL || 'https://pms-api.vayada.com'
      const token = localStorage.getItem('access_token')
      const formData = new FormData()
      formData.append('files', file)
      const res = await fetch(`${pmsUrl}/upload/images`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      })
      if (!res.ok) throw new Error('Upload failed')
      const data = await res.json()
      if (data.images?.[0]?.url) {
        URL.revokeObjectURL(previewUrl)
        setHeroImage(data.images[0].url)
      }
    } catch (err) {
      console.error('Image upload failed:', err)
    } finally {
      setUploading(false)
    }
  }

  const handleRoomImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    try {
      setUploadingRoomImages(true)
      const pmsUrl = process.env.NEXT_PUBLIC_PMS_URL || 'https://pms-api.vayada.com'
      const token = localStorage.getItem('access_token')
      const formData = new FormData()
      Array.from(files).forEach((file) => formData.append('files', file))
      const res = await fetch(`${pmsUrl}/upload/images`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      })
      if (!res.ok) throw new Error('Upload failed')
      const data = await res.json()
      const urls = (data.images || []).map((img: { url: string }) => img.url)
      setRoomImages((prev) => [...prev, ...urls])
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
      return !!(roomName.trim() && maxOccupancy >= 1 && totalRooms >= 1 && Number(baseRate) > 0)
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

        // 4. Create first room type
        try {
          const bedSummary = beds.map((b) => `${b.count} ${b.type}`).join(', ')
          await pmsClient.post('/admin/room-types', {
            name: roomName,
            bedType: bedSummary,
            maxOccupancy,
            size: roomSize ? Number(roomSize) : 0,
            totalRooms,
            description: roomDescription,
            baseRate: Number(baseRate),
            nonRefundableRate: nonRefundableRate ? Number(nonRefundableRate) : undefined,
            currency: roomCurrency || currency,
            images: roomImages,
            amenities,
            features,
          })
        } catch {
          // Non-fatal: room creation may fail but setup can continue
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

  const currentFont = FONT_PAIRINGS.find((f) => f.id === selectedFont) || FONT_PAIRINGS[0]

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

  const addChip = (value: string, list: string[], setList: (v: string[]) => void, setInput: (v: string) => void) => {
    const trimmed = value.trim()
    if (trimmed && !list.includes(trimmed)) {
      setList([...list, trimmed])
    }
    setInput('')
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

      {/* Progress bar — full width */}
      <div className="h-[3px] bg-gray-100 shrink-0">
        <div
          className="h-full bg-primary-600 transition-all duration-300"
          style={{ width: `${(step / 5) * 100}%` }}
        />
      </div>

      {/* ===== STEP 1: Your Property ===== */}
      {step === 1 && (
        <div className="flex-1 overflow-auto">
          <div className="max-w-2xl mx-auto px-6 py-6">
            {stepIndicators}
            {prefilled && (
              <div className="mb-4 px-3 py-2.5 rounded-lg text-[13px] bg-blue-50 text-blue-800 border border-blue-200">
                Some fields were pre-filled from your marketplace profile. Review and adjust as needed.
              </div>
            )}

            <div className="text-center mb-6">
              <h2 className="text-base font-bold text-gray-900">Your Property</h2>
              <p className="text-[12px] text-gray-500 mt-1">Tell us about your property so we can set up everything for you.</p>
            </div>

            {/* Basic Information */}
            <div className="bg-white rounded-xl border border-gray-200 px-5 py-5 space-y-4 mb-5">
              <div className="flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5 text-primary-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
                  <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
                  <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
                  <path d="M10 6h4" /><path d="M10 10h4" /><path d="M10 14h4" /><path d="M10 18h4" />
                </svg>
                <h3 className="text-[13px] font-bold text-gray-900">Basic Information</h3>
              </div>

              <div>
                <label className="block text-[12px] font-semibold text-gray-800 mb-1">
                  Property Name <span className="text-gray-800">*</span>
                </label>
                <input
                  type="text"
                  value={propertyName}
                  onChange={(e) => setPropertyName(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
                  placeholder="e.g. Sundancer Villas & Suites"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-semibold text-gray-800 mb-1">
                    City <span className="text-gray-800">*</span>
                  </label>
                  <input
                    type="text"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
                    placeholder="e.g. Seminyak"
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-gray-800 mb-1">
                    Country <span className="text-gray-800">*</span>
                  </label>
                  <select
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                  >
                    <option value="">Select country</option>
                    {COUNTRY_OPTIONS.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[12px] font-semibold text-gray-800 mb-1">
                  Full Address <span className="text-gray-800">*</span>
                </label>
                <input
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
                  placeholder="Street address, area"
                />
              </div>
            </div>

            {/* Contact Details */}
            <div className="bg-white rounded-xl border border-gray-200 px-5 py-5 space-y-4 mb-5">
              <div className="flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5 text-primary-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                </svg>
                <h3 className="text-[13px] font-bold text-gray-900">Contact Details</h3>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-semibold text-gray-800 mb-1">
                    Email <span className="text-gray-800">*</span>
                  </label>
                  <input
                    type="email"
                    value={reservationEmail}
                    onChange={(e) => setReservationEmail(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
                    placeholder="reservations@yourproperty.com"
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-gray-800 mb-1">
                    Phone Number <span className="text-gray-800">*</span>
                  </label>
                  <input
                    type="tel"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
                    placeholder="+62 812 3456 7890"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="flex items-center gap-1 text-[12px] text-gray-800 mb-1">
                    <svg className="w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 9.75a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375m-13.5 3.01c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
                    </svg>
                    <span className="font-semibold">WhatsApp</span> <span className="text-gray-400 font-normal text-[11px]">(optional)</span>
                  </label>
                  <input
                    type="tel"
                    value={whatsapp}
                    onChange={(e) => setWhatsapp(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
                    placeholder="+62 812 ..."
                  />
                </div>
                <div>
                  <label className="block text-[12px] text-gray-800 mb-1">
                    <span className="font-semibold">Instagram</span> <span className="text-gray-400 font-normal text-[11px]">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={instagram}
                    onChange={(e) => setInstagram(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
                    placeholder="@yourproperty"
                  />
                </div>
                <div>
                  <label className="block text-[12px] text-gray-800 mb-1">
                    <span className="font-semibold">Facebook</span> <span className="text-gray-400 font-normal text-[11px]">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={facebook}
                    onChange={(e) => setFacebook(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
                    placeholder="facebook.com/yourproperty"
                  />
                </div>
              </div>
            </div>

            {/* Currency & Languages */}
            <div className="bg-white rounded-xl border border-gray-200 px-5 py-5 space-y-4">
              <div className="flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5 text-primary-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
                </svg>
                <h3 className="text-[13px] font-bold text-gray-900">Currency & Languages</h3>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-semibold text-gray-800 mb-1">Default Currency <span className="text-gray-800">*</span></label>
                  <select
                    value={currency}
                    onChange={(e) => {
                      const newPrimary = e.target.value
                      setCurrency(newPrimary)
                      setSupportedCurrencies((prev) => prev.filter((c) => c !== newPrimary))
                    }}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                  >
                    {CURRENCY_OPTIONS.map((c) => (
                      <option key={c.code} value={c.code}>{c.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-gray-800 mb-1">Default Language <span className="text-gray-800">*</span></label>
                  <select
                    value={defaultLanguage}
                    onChange={(e) => setDefaultLanguage(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                  >
                    {LANGUAGE_OPTIONS.map((l) => (
                      <option key={l.code} value={l.code}>{l.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[12px] text-gray-800 mb-1">
                  <span className="font-semibold">Additional Currencies</span> <span className="text-gray-400 font-normal text-[11px]">(optional)</span>
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {['EUR', 'GBP', 'IDR', 'AUD', 'THB', 'JPY'].filter((code) => code !== currency).map((code) => {
                    const selected = supportedCurrencies.includes(code)
                    return (
                      <button
                        key={code}
                        onClick={() => {
                          setSupportedCurrencies((prev) =>
                            selected ? prev.filter((x) => x !== code) : [...prev, code]
                          )
                        }}
                        className={`px-2.5 py-0.5 text-[11px] font-medium rounded-full transition-colors ${
                          selected
                            ? 'bg-primary-100 text-primary-700 border border-primary-300'
                            : 'bg-gray-50 text-gray-600 border border-gray-200 hover:bg-gray-100'
                        }`}
                      >
                        {code}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <label className="block text-[12px] text-gray-800 mb-1">
                  <span className="font-semibold">Additional Languages</span> <span className="text-gray-400 font-normal text-[11px]">(optional)</span>
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {LANGUAGE_OPTIONS.filter((l) => l.code !== defaultLanguage).map((l) => {
                    const selected = supportedLanguages.includes(l.code)
                    const displayNames: Record<string, string> = { de: 'Deutsch', fr: 'Fran\u00e7ais', es: 'Espa\u00f1ol', id: 'Bahasa Indonesia', en: 'English' }
                    return (
                      <button
                        key={l.code}
                        onClick={() => {
                          setSupportedLanguages((prev) =>
                            selected ? prev.filter((x) => x !== l.code) : [...prev, l.code]
                          )
                        }}
                        className={`px-3 py-1 text-[12px] font-medium rounded-full transition-colors ${
                          selected
                            ? 'bg-primary-100 text-primary-700 border border-primary-300'
                            : 'bg-gray-50 text-gray-600 border border-gray-200 hover:bg-gray-100'
                        }`}
                      >
                        {displayNames[l.code] || l.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>

            {error && (
              <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-[12px] text-red-700 font-medium">{error}</p>
              </div>
            )}

            <div className="mt-8 flex items-center justify-between">
              <button
                className="text-[13px] font-medium text-gray-500 hover:text-gray-700 transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => { setError(''); setStep(2) }}
                disabled={!canProceed()}
                className="px-6 py-2.5 bg-primary-500 text-white text-[13px] font-semibold rounded-lg hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== STEP 2: Brand & Media — split layout ===== */}
      {step === 2 && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="max-w-6xl mx-auto px-6 pt-6 w-full shrink-0">{stepIndicators}</div>
          <div className="max-w-6xl mx-auto px-6 pb-5 flex gap-5 flex-1 min-h-0 w-full">

            {/* LEFT: Controls panel */}
            <div className="w-[380px] shrink-0 flex flex-col min-h-0">
              <div className="flex-1 overflow-y-auto space-y-3 pb-3">

                {/* Hero Image */}
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h2 className="text-[13px] font-semibold text-gray-900">Hero Image</h2>
                  <p className="text-[12px] text-gray-500 mt-0.5 mb-2.5">1920x800px recommended</p>

                  {heroImage ? (
                    <div className="relative rounded-lg overflow-hidden">
                      <img src={heroImage} alt="Hero" className="w-full h-36 object-cover" />
                      {uploading && (
                        <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
                          <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        </div>
                      )}
                      <button
                        onClick={() => { setHeroImage(''); if (fileInputRef.current) fileInputRef.current.value = '' }}
                        className="absolute top-1.5 right-1.5 w-6 h-6 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center transition-colors"
                      >
                        <XMarkIcon className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full h-36 border-2 border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center gap-1.5 text-gray-400 hover:border-gray-400 hover:text-gray-500 transition-colors"
                    >
                      <PhotoIcon className="w-6 h-6" />
                      <span className="text-[12px]">Drop image or click to upload</span>
                    </button>
                  )}

                  <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />

                  {heroImage && (
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="mt-2 w-full py-1.5 text-[12px] text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      Replace Image
                    </button>
                  )}
                </div>

                {/* Colour Profile */}
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h2 className="text-[13px] font-semibold text-gray-900">Colour Profile</h2>
                  <p className="text-[12px] text-gray-500 mt-0.5 mb-3">Define your brand colors</p>

                  <div className="space-y-4">
                    <div>
                      <h3 className="text-[12px] font-semibold text-gray-900">Primary Brand Color</h3>
                      <p className="text-[11px] text-gray-500 mt-0.5 mb-1.5">Buttons, links, and accents</p>
                      <div className="flex items-center gap-2">
                        <label
                          className="w-8 h-8 rounded-full border border-gray-200 cursor-pointer shrink-0"
                          style={{ backgroundColor: primaryColor }}
                        >
                          <input type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} className="opacity-0 w-0 h-0" />
                        </label>
                        <input
                          type="text"
                          value={primaryColor}
                          onChange={(e) => setPrimaryColor(e.target.value)}
                          className="w-24 px-2 py-1 border border-gray-300 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900"
                        />
                      </div>
                    </div>

                    <div>
                      <h3 className="text-[12px] font-semibold text-gray-900">Background Accent</h3>
                      <p className="text-[11px] text-gray-500 mt-0.5 mb-1.5">Card and section backgrounds</p>
                      <div className="flex items-center gap-2">
                        <label
                          className="w-8 h-8 rounded-full border border-gray-200 cursor-pointer shrink-0"
                          style={{ backgroundColor: accentColor }}
                        >
                          <input type="color" value={accentColor} onChange={(e) => setAccentColor(e.target.value)} className="opacity-0 w-0 h-0" />
                        </label>
                        <input
                          type="text"
                          value={accentColor}
                          onChange={(e) => setAccentColor(e.target.value)}
                          className="w-24 px-2 py-1 border border-gray-300 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900"
                        />
                      </div>
                    </div>

                    {/* Quick Presets — 2x3 grid */}
                    <div>
                      <h3 className="text-[12px] font-semibold text-gray-900 mb-1.5">Quick Presets</h3>
                      <div className="grid grid-cols-2 gap-1.5">
                        {COLOR_PRESETS.map((preset) => (
                          <button
                            key={preset.name}
                            onClick={() => { setPrimaryColor(preset.primary); setAccentColor(preset.accent) }}
                            className={`flex items-center gap-2 px-2.5 py-1.5 border rounded-lg text-[12px] text-gray-700 hover:bg-gray-50 transition-colors ${
                              primaryColor === preset.primary ? 'border-primary-500 bg-primary-50/30' : 'border-gray-200'
                            }`}
                          >
                            <span className="w-4 h-4 rounded-full shrink-0 border border-gray-200" style={{ backgroundColor: preset.primary }} />
                            {preset.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Typography */}
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h2 className="text-[13px] font-semibold text-gray-900">Typography</h2>
                  <p className="text-[12px] text-gray-500 mt-0.5 mb-3">Select a font pairing</p>

                  <div className="space-y-1.5">
                    {FONT_PAIRINGS.map((pairing) => (
                      <button
                        key={pairing.id}
                        onClick={() => setSelectedFont(pairing.id)}
                        className={`w-full flex items-center justify-between p-3 rounded-lg border transition-all text-left ${
                          selectedFont === pairing.id
                            ? 'border-primary-500 bg-primary-50/30 ring-1 ring-primary-500'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div>
                          <div className="flex items-center gap-1">
                            <span className="text-[12px] font-semibold text-gray-900">{pairing.name}</span>
                            {selectedFont === pairing.id && (
                              <CheckIcon className="w-3.5 h-3.5 text-primary-500" />
                            )}
                          </div>
                          <span className="text-[11px] text-gray-500">{pairing.fonts}</span>
                        </div>
                        <span className="text-sm text-gray-600" style={{ fontFamily: pairing.headingFamily }}>
                          {pairing.preview}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Property Description */}
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h2 className="text-[13px] font-semibold text-gray-900">Property Description</h2>
                  <p className="text-[12px] text-gray-500 mt-0.5 mb-2.5">Shown below your property name on the booking page</p>
                  <textarea
                    value={propertyDescription}
                    onChange={(e) => {
                      if (e.target.value.length <= 1000) setPropertyDescription(e.target.value)
                    }}
                    rows={4}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900 resize-none"
                    placeholder="A boutique escape featuring private pools, ocean views, and tranquil luxury..."
                  />
                  <p className="text-[11px] text-gray-400 mt-1 text-right">{propertyDescription.length}/1000 characters</p>
                </div>

                {/* Booking Filters */}
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h2 className="text-[13px] font-semibold text-gray-900">Booking Filters</h2>
                  <p className="text-[12px] text-gray-500 mt-0.5 mb-3">Add filters that guests can use on your booking page</p>

                  <div className="flex gap-2 mb-2">
                    <input
                      type="text"
                      value={filterInput}
                      onChange={(e) => setFilterInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); addChip(filterInput, bookingFilters, setBookingFilters, setFilterInput) }
                      }}
                      className="flex-1 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
                      placeholder="e.g. Pool View, Pet Friendly"
                    />
                    <button
                      onClick={() => addChip(filterInput, bookingFilters, setBookingFilters, setFilterInput)}
                      className="px-3 py-1.5 bg-gray-100 text-gray-700 text-[12px] font-medium rounded-lg hover:bg-gray-200 transition-colors"
                    >
                      Add
                    </button>
                  </div>

                  {bookingFilters.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {bookingFilters.map((f) => (
                        <span key={f} className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary-50 text-primary-700 text-[11px] font-medium rounded-full">
                          {AVAILABLE_FILTERS.find((af) => af.key === f)?.label || f}
                          <button onClick={() => setBookingFilters(bookingFilters.filter((x) => x !== f))} className="ml-0.5 text-primary-400 hover:text-primary-600">&times;</button>
                        </span>
                      ))}
                    </div>
                  )}

                  <div>
                    <p className="text-[11px] text-gray-400 font-medium mb-1.5">Suggestions</p>
                    <div className="flex flex-wrap gap-1.5">
                      {AVAILABLE_FILTERS.filter((f) => !bookingFilters.includes(f.key)).map((filter) => (
                        <button
                          key={filter.key}
                          onClick={() => setBookingFilters((prev) => [...prev, filter.key])}
                          className="text-[11px] px-2 py-0.5 bg-white border border-gray-200 rounded-full text-gray-500 hover:bg-gray-50 transition-colors"
                        >
                          + {filter.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Bottom buttons */}
              <div className="pt-3 shrink-0 border-t border-gray-100 flex items-center justify-between gap-3">
                <button
                  onClick={() => setStep(1)}
                  className="px-4 py-2 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={() => { setError(''); setStep(3) }}
                  disabled={!canProceed()}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-primary-500 text-white text-[13px] font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                </button>
              </div>

              {error && (
                <div className="mt-2 bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-[12px] text-red-700 font-medium">{error}</p>
                </div>
              )}
            </div>

            {/* RIGHT: Live preview */}
            <div className="flex-1 min-w-0 bg-white rounded-lg border border-gray-200 flex flex-col min-h-0">
              {/* Browser chrome bar */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 shrink-0 bg-gray-50">
                <div className="flex gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
                  <span className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
                  <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
                </div>
                <div className="flex-1 bg-white rounded-md px-3 py-0.5 text-[11px] text-gray-500 text-center truncate border border-gray-200">
                  yourhotel.vayada.com
                </div>
              </div>

              {/* Preview content */}
              <div className="flex-1 overflow-y-auto bg-white" style={{ fontFamily: currentFont.bodyFamily }}>

                {/* Hero section */}
                <div className="relative h-[280px] w-full">
                  {heroImage ? (
                    <img src={heroImage} alt="Hero" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full bg-gray-300" />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-black/60" />

                  {/* Navigation */}
                  <div className="absolute top-0 left-0 right-0 z-10">
                    <div className="flex items-center justify-between px-4 h-10">
                      <span className="text-[11px] font-semibold text-white" style={{ fontFamily: currentFont.bodyFamily }}>
                        {propertyName || 'Your Hotel'}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span className="px-2.5 py-0.5 text-[9px] font-semibold text-white rounded-full" style={{ backgroundColor: primaryColor }}>
                          Contact
                        </span>
                        <span className="px-2.5 py-0.5 text-[9px] font-semibold text-white rounded-full border border-white/60">
                          Refer a Guest
                        </span>
                        <span className="px-2 py-0.5 text-[9px] font-semibold text-white rounded-full border border-white/60">
                          {defaultLanguage.toUpperCase()}
                        </span>
                        <span className="px-2 py-0.5 text-[9px] font-semibold text-white rounded-full border border-white/60">
                          {currency}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Hero content */}
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
                    <h2
                      className="text-2xl italic text-white mb-1.5"
                      style={{ fontFamily: currentFont.headingFamily }}
                    >
                      {propertyName || 'Your Hotel Name'}
                    </h2>
                    <p
                      className="text-[11px] text-white/90 leading-relaxed max-w-sm"
                      style={{ fontFamily: currentFont.bodyFamily }}
                    >
                      {propertyDescription || 'Your hotel description will appear here.'}
                    </p>
                  </div>
                </div>

                {/* Search bar */}
                <div className="relative z-20 max-w-[92%] mx-auto -mt-6">
                  <div className="bg-white rounded-xl shadow-lg border border-gray-100 px-3 py-2.5 flex items-center gap-2">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0" style={{ backgroundColor: primaryColor + '15' }}>
                        <svg className="w-3 h-3" style={{ color: primaryColor }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-[8px] text-gray-500 font-medium uppercase tracking-wide" style={{ fontFamily: currentFont.bodyFamily }}>Your Stay</p>
                        <p className="text-[10px] font-semibold text-gray-900" style={{ fontFamily: currentFont.bodyFamily }}>Feb 13 — Feb 18, 2026</p>
                        <p className="text-[8px] text-gray-500" style={{ fontFamily: currentFont.bodyFamily }}>5 nights</p>
                      </div>
                    </div>
                    <div className="w-px h-8 bg-gray-200" />
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0" style={{ backgroundColor: primaryColor + '15' }}>
                        <svg className="w-3 h-3" style={{ color: primaryColor }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-[8px] text-gray-500 font-medium uppercase tracking-wide" style={{ fontFamily: currentFont.bodyFamily }}>Guests</p>
                        <p className="text-[10px] font-semibold text-gray-900" style={{ fontFamily: currentFont.bodyFamily }}>2 Adults</p>
                        <p className="text-[8px] text-gray-500" style={{ fontFamily: currentFont.bodyFamily }}>1 Room</p>
                      </div>
                    </div>
                    <button
                      className="px-3 py-1.5 rounded-full text-[9px] font-semibold text-white shrink-0"
                      style={{ backgroundColor: primaryColor }}
                    >
                      Check Availability
                    </button>
                  </div>
                </div>

                {/* Room card preview */}
                <div className="px-4 py-5">
                  <h3 className="text-sm text-gray-900 mb-3" style={{ fontFamily: currentFont.headingFamily }}>
                    Available Accommodations
                  </h3>
                  <div className="border border-gray-200 rounded-xl overflow-hidden">
                    <div className="flex">
                      <div className="relative w-[160px] flex-shrink-0">
                        <img
                          src="https://images.unsplash.com/photo-1590490360182-c33d57733427?w=400&q=80"
                          alt="Room"
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <div className="flex-1 p-3">
                        <h4 className="text-[12px] font-bold text-gray-900" style={{ fontFamily: currentFont.headingFamily }}>
                          Deluxe Mountain Room
                        </h4>
                        <div className="flex items-center gap-2 text-[9px] text-gray-500 mt-0.5" style={{ fontFamily: currentFont.bodyFamily }}>
                          <span>32 m&sup2;</span>
                          <span>Up to 2 guests</span>
                        </div>
                        <div className="flex flex-wrap gap-1 mt-2 mb-2">
                          {['Mountain View', 'Balcony', 'Mini Bar'].map((feat) => (
                            <span key={feat} className="inline-flex items-center gap-0.5 text-[8px] text-gray-700 border border-gray-200 px-1.5 py-0.5 rounded-full">
                              <svg className="w-2 h-2 flex-shrink-0" style={{ color: primaryColor }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                              </svg>
                              {feat}
                            </span>
                          ))}
                        </div>
                        <div className="border-t border-gray-100 pt-2">
                          <div className="rounded-lg border-2 px-2.5 py-2" style={{ borderColor: primaryColor }}>
                            <div className="flex items-center justify-between">
                              <p className="text-[9px] font-bold text-gray-900" style={{ fontFamily: currentFont.bodyFamily }}>Flexible Rate</p>
                              <p className="text-[11px] font-bold" style={{ color: primaryColor, fontFamily: currentFont.bodyFamily }}>
                                {currency} 120
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== STEP 3: Choose PMS ===== */}
      {step === 3 && (
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
                  className={`w-full text-left px-4 py-4 rounded-xl border transition-all ${
                    selectedPms === pms.id
                      ? 'border-primary-500 ring-2 ring-primary-500/20 bg-primary-50/20'
                      : pms.available
                        ? 'border-gray-200 hover:border-gray-300 bg-white'
                        : 'border-gray-100 bg-gray-50/50 opacity-50 cursor-not-allowed'
                  }`}
                >
                  <div className="flex items-start gap-3.5">
                    {/* PMS Icon */}
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                      pms.id === 'vayada' ? 'bg-blue-600' :
                      pms.id === 'cloudbeds' ? 'bg-slate-700' :
                      pms.id === 'ezee' ? 'bg-orange-500' :
                      'bg-blue-500'
                    }`}>
                      {pms.id === 'vayada' && (
                        <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                      {pms.id === 'cloudbeds' && (
                        <span className="text-white text-[13px] font-bold">C</span>
                      )}
                      {pms.id === 'ezee' && (
                        <span className="text-white text-[10px] font-bold leading-none">eZee</span>
                      )}
                      {pms.id === 'siteminder' && (
                        <span className="text-white text-[13px] font-bold">S</span>
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
                          <span key={feat} className={`text-[10px] px-2 py-0.5 rounded-full ${
                            pms.available
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
                onClick={() => setStep(2)}
                className="px-4 py-2 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => { setError(''); setStep(4) }}
                disabled={!canProceed()}
                className="px-6 py-2 bg-primary-500 text-white text-[13px] font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== STEP 4: Rooms & Rates ===== */}
      {step === 4 && (
        <div className="flex-1 overflow-auto">
          <div className="max-w-3xl mx-auto px-6 py-6">
            {stepIndicators}
            <div className="mb-5">
              <h2 className="text-[18px] font-bold text-gray-900" style={{ fontFamily: "'Playfair Display', serif" }}>Rooms & Rates</h2>
              <p className="text-[12px] text-gray-500 mt-1">Set up your first room type. Everything here maps directly to the room card guests see on the booking page.</p>
            </div>

            {/* Room Tabs */}
            <div className="flex gap-6 mb-6 border-b border-gray-200">
              {ROOM_TABS.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveRoomTab(tab.key)}
                  className={`pb-2.5 text-[12px] font-medium transition-colors relative ${
                    activeRoomTab === tab.key
                      ? 'text-gray-900'
                      : 'text-gray-400 hover:text-gray-600'
                  }`}
                >
                  {tab.label}
                  {activeRoomTab === tab.key && (
                    <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-gray-900 rounded-full" />
                  )}
                </button>
              ))}
            </div>

            {/* Room Details Tab */}
            {activeRoomTab === 'details' && (
              <div className="bg-white rounded-xl border border-gray-200 px-6 py-6 space-y-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">Room Type Basics</h3>
                  <span className="text-[11px] font-medium text-red-500">Required</span>
                </div>

                <div className="bg-blue-50/70 rounded-lg px-4 py-2.5">
                  <p className="text-[11px] text-blue-700">
                    <span className="mr-1.5">→</span>
                    <span className="font-medium">Booking engine:</span> Room card title · &quot;View Details&quot; modal header · Booking summary · PMS Rooms & Rates list
                  </p>
                </div>

                {/* Room Type Name */}
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <label className="text-[12px] font-semibold text-gray-900">
                      Room Type Name <span className="text-red-500">*</span>
                    </label>
                    <span className="text-[8px] font-semibold px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded uppercase tracking-wide">Card Title</span>
                  </div>
                  <input
                    type="text"
                    value={roomName}
                    onChange={(e) => setRoomName(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                    placeholder="e.g. Two-Bedroom Villa"
                  />
                  <p className="text-[10px] text-gray-400 mt-1">Shown as the bold heading on the room card and in the booking summary</p>
                </div>

                {/* Beds */}
                <div>
                  <div className="flex items-center gap-2 mb-0.5">
                    <label className="text-[12px] font-semibold text-gray-900">Beds</label>
                    <span className="text-[8px] font-semibold px-1.5 py-0.5 bg-gray-200 text-gray-600 rounded uppercase tracking-wide">Modal</span>
                  </div>
                  <p className="text-[10px] text-gray-400 mb-2">Add all bed types available in this room</p>
                  <div className="space-y-2">
                    {beds.map((bed, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <select
                          value={bed.type}
                          onChange={(e) => {
                            const updated = [...beds]
                            updated[idx] = { ...updated[idx], type: e.target.value }
                            setBeds(updated)
                          }}
                          className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 appearance-none"
                          style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239CA3AF' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center' }}
                        >
                          {BED_TYPES.map((bt) => (
                            <option key={bt} value={bt}>{bt}</option>
                          ))}
                        </select>
                        <input
                          type="number"
                          min={1}
                          value={bed.count}
                          onChange={(e) => {
                            const updated = [...beds]
                            updated[idx] = { ...updated[idx], count: Math.max(1, Number(e.target.value)) }
                            setBeds(updated)
                          }}
                          className="w-16 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                        />
                        {beds.length > 1 && (
                          <button
                            onClick={() => setBeds(beds.filter((_, i) => i !== idx))}
                            className="p-1.5 text-gray-400 hover:text-red-500 transition-colors"
                          >
                            <XMarkIcon className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={() => setBeds([...beds, { type: 'King Bed', count: 1 }])}
                    className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-gray-700 font-medium px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <PlusIcon className="w-3.5 h-3.5" /> Add Bed
                  </button>
                </div>

                {/* Max Occupancy - full width */}
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <label className="text-[12px] font-semibold text-gray-900">
                      Max Occupancy <span className="text-red-500">*</span>
                    </label>
                    <span className="text-[8px] font-semibold px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded uppercase tracking-wide">Card</span>
                  </div>
                  <input
                    type="number"
                    min={1}
                    value={maxOccupancy}
                    onChange={(e) => setMaxOccupancy(Math.max(1, Number(e.target.value)))}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                  />
                  <p className="text-[10px] text-gray-400 mt-1">Shows as &quot;Up to X guests&quot; on room card</p>
                </div>

                {/* Room Size + Total Rooms - 2 col */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <label className="text-[12px] font-semibold text-gray-900">
                        Room Size (m&sup2;)
                      </label>
                      <span className="text-[8px] font-semibold px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded uppercase tracking-wide">Card</span>
                      <span className="text-[8px] font-semibold px-1.5 py-0.5 bg-gray-200 text-gray-600 rounded uppercase tracking-wide">Modal</span>
                    </div>
                    <input
                      type="number"
                      min={0}
                      value={roomSize}
                      onChange={(e) => setRoomSize(e.target.value)}
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                      placeholder="e.g. 150"
                    />
                    <p className="text-[10px] text-gray-400 mt-1">Shown as &quot;150 m&sup2;&quot; with icon on room card and modal</p>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <label className="text-[12px] font-semibold text-gray-900">
                        Total Rooms of this Type <span className="text-red-500">*</span>
                      </label>
                      <span className="text-[8px] font-semibold px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded uppercase tracking-wide">PMS</span>
                    </div>
                    <input
                      type="number"
                      min={1}
                      value={totalRooms}
                      onChange={(e) => setTotalRooms(Math.max(1, Number(e.target.value)))}
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                    />
                    <p className="text-[10px] text-gray-400 mt-1">Determines availability in PMS calendar</p>
                  </div>
                </div>

                {/* Room Description */}
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <label className="text-[12px] font-semibold text-gray-900">Room Description</label>
                    <span className="text-[8px] font-semibold px-1.5 py-0.5 bg-gray-200 text-gray-600 rounded uppercase tracking-wide">Modal</span>
                  </div>
                  <textarea
                    value={roomDescription}
                    onChange={(e) => setRoomDescription(e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 resize-vertical"
                    placeholder="The private pool is the standout feature of this villa. The air-conditioned villa has 2 bedrooms and 2 bathrooms..."
                  />
                  <p className="text-[10px] text-gray-400 mt-1">Shown in the &quot;View Details&quot; modal when a guest clicks to see more</p>
                </div>

                {/* Room Category Tag */}
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <label className="text-[12px] font-semibold text-gray-900">Room Category Tag</label>
                    <span className="text-[10px] text-gray-400">(shows in PMS room list)</span>
                  </div>
                  <select
                    value={roomCategory}
                    onChange={(e) => setRoomCategory(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 appearance-none"
                    style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239CA3AF' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center' }}
                  >
                    <option value="">Select category</option>
                    {ROOM_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>{cat}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Pricing & Rates Tab */}
            {activeRoomTab === 'pricing' && (
              <div className="bg-white rounded-xl border border-gray-200 px-6 py-6 space-y-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">Rate Configuration</h3>
                  <span className="text-[11px] font-medium text-red-500">Required</span>
                </div>

                <div className="bg-blue-50/70 rounded-lg px-4 py-2.5">
                  <p className="text-[11px] text-blue-700">
                    <span className="mr-1.5">→</span>
                    <span className="font-medium">Booking engine:</span> &quot;RATE OPTIONS&quot; section · Flexible Rate card · Non-Refundable Rate card with % OFF badge · Per-night price · Total price
                  </p>
                </div>

                {/* Flexible Rate sub-card */}
                <div className="border border-gray-200 rounded-xl px-5 py-5 space-y-4">
                  <h4 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Flexible Rate</h4>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1.5">
                        <label className="text-[12px] font-semibold text-gray-900">
                          Base Rate (per night) <span className="text-red-500">*</span>
                        </label>
                        <span className="text-[8px] font-semibold px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded uppercase tracking-wide">Rate Card</span>
                      </div>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={baseRate}
                        onChange={(e) => setBaseRate(e.target.value)}
                        className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                        placeholder="e.g. 425"
                      />
                      <p className="text-[10px] text-gray-400 mt-1">Shows as &quot;Flexible Rate · Free cancellation until X days before · 0 $/per&quot;</p>
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1.5">
                        <label className="text-[12px] font-semibold text-gray-900">Free Cancellation Until</label>
                        <span className="text-[8px] font-semibold px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded uppercase tracking-wide">Rate Card</span>
                      </div>
                      <select
                        value={freeCancellationDays}
                        onChange={(e) => setFreeCancellationDays(e.target.value)}
                        className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 appearance-none"
                        style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239CA3AF' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center' }}
                      >
                        <option value="1 day before">1 day before</option>
                        <option value="2 days before">2 days before</option>
                        <option value="3 days before">3 days before</option>
                        <option value="5 days before">5 days before</option>
                        <option value="7 days before">7 days before</option>
                        <option value="14 days before">14 days before</option>
                        <option value="30 days before">30 days before</option>
                      </select>
                    </div>
                  </div>
                </div>

                {/* Non-Refundable Rate sub-card */}
                <div className="border border-gray-200 rounded-xl px-5 py-5 space-y-4">
                  <div className="flex items-center gap-2">
                    <h4 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Non-Refundable Rate</h4>
                    <span className="text-[10px] text-gray-400">— generates &quot;-X% OFF&quot; badge automatically</span>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1.5">
                        <label className="text-[12px] font-semibold text-gray-900">Non-Refundable Rate</label>
                        <span className="text-[8px] font-semibold px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded uppercase tracking-wide">Rate Card + Badge</span>
                      </div>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={nonRefundableRate}
                        onChange={(e) => setNonRefundableRate(e.target.value)}
                        className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                        placeholder="e.g. 354"
                      />
                      <p className="text-[10px] text-gray-400 mt-1">Shows as &quot;Non-Refundable Rate · -X% OFF · 0 $/per&quot; — discount % is auto-calculated</p>
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1.5">
                        <label className="text-[12px] font-semibold text-gray-900">Availability Note</label>
                        <span className="text-[10px] text-gray-400">(optional)</span>
                        <span className="text-[8px] font-semibold px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded uppercase tracking-wide">Below Rates</span>
                      </div>
                      <input
                        type="text"
                        value={availabilityNote}
                        onChange={(e) => setAvailabilityNote(e.target.value)}
                        className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                        placeholder="e.g. Only 1 left at this rate"
                      />
                      <p className="text-[10px] text-gray-400 mt-1">Shows as &quot;· Only 1 left at this rate&quot; below rate options</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Images & Amenities Tab */}
            {activeRoomTab === 'media' && (
              <div className="space-y-4">
                {/* Room Images Section */}
                <div className="bg-white rounded-xl border border-gray-200 px-6 py-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">Room Images</h3>
                    <span className="text-[11px] font-medium text-amber-600">Strongly recommended</span>
                  </div>

                  <div className="bg-blue-50/70 rounded-lg px-4 py-2.5">
                    <p className="text-[11px] text-blue-700">
                      <span className="mr-1.5">→</span>
                      <span className="font-medium">Booking engine:</span> Room card left-side image slider · &quot;View Details&quot; modal gallery with thumbnail strip · Photo count badge
                    </p>
                  </div>

                  {/* Uploaded images preview */}
                  {roomImages.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {roomImages.map((url, idx) => (
                        <div key={idx} className="relative w-24 h-24 rounded-lg overflow-hidden border border-gray-200">
                          <img src={url} alt={`Room ${idx + 1}`} className="w-full h-full object-cover" />
                          <button
                            onClick={() => setRoomImages(roomImages.filter((_, i) => i !== idx))}
                            className="absolute top-1 right-1 w-5 h-5 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center"
                          >
                            <XMarkIcon className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Upload drop zone */}
                  <button
                    onClick={() => roomFileInputRef.current?.click()}
                    disabled={uploadingRoomImages}
                    className="w-full border-2 border-dashed border-gray-300 rounded-xl py-8 flex flex-col items-center justify-center gap-2 text-gray-400 hover:border-gray-400 hover:bg-gray-50/50 transition-colors"
                  >
                    {uploadingRoomImages ? (
                      <div className="w-8 h-8 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <>
                        <svg className="w-10 h-10 text-gray-300" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <rect x="6" y="6" width="36" height="36" rx="4" />
                          <path d="M6 34l10-10 8 8 6-6 12 12" />
                          <circle cx="18" cy="18" r="3" />
                          <path d="M34 6v8h8" strokeLinecap="round" />
                        </svg>
                        <span className="text-[12px] font-semibold text-gray-700">Upload room photos — drag to reorder</span>
                        <span className="text-[11px] text-gray-400 italic">First image = card cover photo · All images appear in modal gallery</span>
                      </>
                    )}
                  </button>
                  <input
                    ref={roomFileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleRoomImageUpload}
                    className="hidden"
                  />

                  <p className="text-[10px] text-gray-400">Shown in: room listing card (left side) · &quot;View Details&quot; modal with prev/next navigation · thumbnail strip at bottom of modal</p>
                </div>

                {/* Amenities & Features Section */}
                <div className="bg-white rounded-xl border border-gray-200 px-6 py-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">Amenities & Features</h3>
                    <span className="text-[11px] font-medium text-gray-400">Optional</span>
                  </div>

                  <div className="bg-blue-50/70 rounded-lg px-4 py-2.5">
                    <p className="text-[11px] text-blue-700">
                      <span className="mr-1.5">→</span>
                      <span className="font-medium">Booking engine:</span> Amenity tags row below room name ({'✓ Entire villa · ✓ Free WiFi · ✓ Air conditioning...'}) · &quot;+X more&quot; badge · &quot;View Full Amenities (X)&quot; in modal
                    </p>
                  </div>

                  <div>
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[12px] font-semibold text-gray-900">Quick-add amenities</span>
                      <span className="text-[8px] font-semibold px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded uppercase tracking-wide">Room Card Tags</span>
                    </div>
                    <p className="text-[10px] text-gray-400 mb-3">First 4–5 shown on room card; all shown in &quot;View Full Amenities&quot; in modal</p>

                    <div className="flex flex-wrap gap-2">
                      {QUICK_AMENITIES.map((item) => {
                        const isSelected = amenities.includes(item.label)
                        return (
                          <button
                            key={item.label}
                            onClick={() => {
                              if (isSelected) {
                                setAmenities(amenities.filter((a) => a !== item.label))
                              } else {
                                setAmenities([...amenities, item.label])
                              }
                            }}
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                              isSelected
                                ? 'border-primary-300 bg-primary-50 text-primary-700'
                                : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                            }`}
                          >
                            <span className="text-[13px]">{item.emoji}</span>
                            {item.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Book Direct Benefits Tab */}
            {activeRoomTab === 'benefits' && (
              <div className="bg-white rounded-xl border border-gray-200 px-6 py-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">Book Direct Benefits</h3>
                  <span className="text-[11px] font-medium text-gray-400">Optional</span>
                </div>

                <div className="bg-blue-50/70 rounded-lg px-4 py-2.5">
                  <p className="text-[11px] text-blue-700">
                    <span className="mr-1.5">→</span>
                    <span className="font-medium">Booking engine:</span> &quot;Book Direct Benefits&quot; card with ✓ list in &quot;View Details&quot; modal · Differentiates your direct channel from OTAs
                  </p>
                </div>

                <p className="text-[11px] text-gray-500">These appear in the room detail modal under a &quot;Book Direct Benefits&quot; section, encouraging guests to book via your website instead of OTAs.</p>

                {/* Predefined benefit options */}
                <div className="space-y-2">
                  {BENEFIT_OPTIONS.map((benefit) => {
                    const isSelected = bookDirectBenefits.includes(benefit)
                    return (
                      <button
                        key={benefit}
                        onClick={() => {
                          if (isSelected) {
                            setBookDirectBenefits(bookDirectBenefits.filter((b) => b !== benefit))
                          } else {
                            setBookDirectBenefits([...bookDirectBenefits, benefit])
                          }
                        }}
                        className={`w-full flex items-center gap-3 px-4 py-2 rounded-lg border text-left transition-colors ${
                          isSelected
                            ? 'border-primary-300 bg-primary-50/30'
                            : 'border-gray-200 bg-gray-50 hover:bg-gray-100'
                        }`}
                      >
                        <div className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 flex items-center justify-center ${
                          isSelected ? 'border-primary-500 bg-primary-500' : 'border-gray-300'
                        }`}>
                          {isSelected && (
                            <CheckIcon className="w-2 h-2 text-white" />
                          )}
                        </div>
                        <span className="text-[12px] text-gray-700">{benefit}</span>
                      </button>
                    )
                  })}
                </div>

                {/* Custom benefit input */}
                <div>
                  <label className="block text-[11px] text-gray-500 mb-1.5">Custom Benefit <span className="text-gray-400">(optional)</span></label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={benefitInput}
                      onChange={(e) => setBenefitInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); addChip(benefitInput, bookDirectBenefits, setBookDirectBenefits, setBenefitInput) }
                      }}
                      className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                      placeholder="e.g. Complimentary sunset cocktail"
                    />
                    <button
                      onClick={() => addChip(benefitInput, bookDirectBenefits, setBookDirectBenefits, setBenefitInput)}
                      className="px-3 py-2 border border-gray-200 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
                    >
                      <PlusIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-[11px] text-red-700 font-medium">{error}</p>
              </div>
            )}

            <div className="mt-6 flex justify-between">
              <button
                onClick={() => setStep(3)}
                className="px-4 py-2 text-[12px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => { setError(''); setStep(5) }}
                disabled={!canProceed()}
                className="px-6 py-2 bg-primary-500 text-white text-[12px] font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== STEP 5: Policies & Operations ===== */}
      {step === 5 && (
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
                onClick={() => setStep(4)}
                className="px-4 py-2 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleComplete}
                disabled={saving}
                className="px-8 py-2.5 bg-primary-500 text-white text-[14px] font-semibold rounded-lg hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-2"
              >
                {saving ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Launching...
                  </>
                ) : (
                  'Launch Property →'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
