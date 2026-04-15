'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { authService } from '@/services/auth'
import { settingsService } from '@/services/settings'
import { pmsClient } from '@/services/api/pmsClient'
import { checkSetupStatus } from '@/lib/utils/setupStatus'
import { FONT_PAIRINGS } from '@/lib/constants/branding'
import { CheckIcon } from '@heroicons/react/24/outline'
import { uploadSingleImage, uploadImages } from '@/lib/utils/uploadImage'

import PropertyStep from '@/components/setup/PropertyStep'
import BrandMediaStep from '@/components/setup/BrandMediaStep'
import PmsStep from '@/components/setup/PmsStep'
import RoomsStep, { type RoomType, createEmptyRoom, hasSeasonCoverageGaps } from '@/components/setup/RoomsStep'
import PoliciesStep from '@/components/setup/PoliciesStep'
import AddonsStep, { type SetupAddon } from '@/components/setup/AddonsStep'
import BenefitsStep from '@/components/setup/BenefitsStep'
import PromoCodesStep, { type SetupPromoCode } from '@/components/setup/PromoCodesStep'

const GOOGLE_FONTS_URL = 'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Source+Sans+Pro:wght@300;400;600;700&family=Inter:wght@300;400;500;600;700&family=Cormorant+Garamond:ital,wght@0,400;0,700;1,400&family=Lato:wght@300;400;700&display=swap'

const STEPS = [
  { number: 1, label: 'Your Property' },
  { number: 2, label: 'Brand & Media' },
  // { number: 3, label: 'Choose PMS' },  // Hidden — only vayada PMS for now
  { number: 4, label: 'Rooms & Rates' },
  { number: 5, label: 'Add-ons' },
  // { number: 6, label: 'Promo Codes' },  // Hidden — can be re-enabled later
  { number: 7, label: 'Benefits' },
  { number: 8, label: 'Policies' },
]

type RoomTab = 'details' | 'pricing' | 'media' | 'benefits'

export default function SetupPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [step, setStep] = useState(1)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [prefilled, setPrefilled] = useState(false)
  const [inviteCode, setInviteCode] = useState('')
  const [inviteError, setInviteError] = useState('')
  const [applyingInvite, setApplyingInvite] = useState(false)
  const [appliedInviteCode, setAppliedInviteCode] = useState('')
  const [showWizard, setShowWizard] = useState(false)

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
  const [tiktok, setTiktok] = useState('')
  const [youtube, setYoutube] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [defaultLanguage, setDefaultLanguage] = useState('en')
  const [supportedCurrencies, setSupportedCurrencies] = useState<string[]>([])
  const [supportedLanguages, setSupportedLanguages] = useState<string[]>([])

  // Step 2: Brand & Media
  const [heroImage, setHeroImage] = useState('')
  const [primaryColor, setPrimaryColor] = useState('#4F46E5')
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
  const roomFileInputRef = useRef<HTMLInputElement>(null)
  const [uploadingRoomImages, setUploadingRoomImages] = useState(false)

  // Step 5: Add-ons
  const [setupAddons, setSetupAddons] = useState<SetupAddon[]>([])

  // Step 6: Promo Codes
  const [setupPromoCodes, setSetupPromoCodes] = useState<SetupPromoCode[]>([])

  // Step 7: Benefits
  const [benefits, setBenefits] = useState<string[]>([])

  // Step 6: Policies & Operations
  const [checkInFrom, setCheckInFrom] = useState('14:00')
  const [checkInUntil, setCheckInUntil] = useState('22:00')
  const [checkOutFrom, setCheckOutFrom] = useState('07:00')
  const [checkOutUntil, setCheckOutUntil] = useState('11:00')
  const [payAtHotel, setPayAtHotel] = useState(true)
  const [payAtHotelMethods, setPayAtHotelMethods] = useState<string[]>(['cash', 'card'])
  const [onlineCardPayment, setOnlineCardPayment] = useState(false)
  const [bankTransfer, setBankTransfer] = useState(false)
  const [payoutAccountHolder, setPayoutAccountHolder] = useState('')
  const [payoutIban, setPayoutIban] = useState('')
  const [payoutBankName, setPayoutBankName] = useState('')
  const [payoutSwift, setPayoutSwift] = useState('')
  const [specialRequests, setSpecialRequests] = useState(true)
  const [estimatedArrivalTime, setEstimatedArrivalTime] = useState(false)
  const [numberOfGuests, setNumberOfGuests] = useState(false)
  const [enableReferAGuest, setEnableReferAGuest] = useState(false)
  const [paymentProvider, setPaymentProvider] = useState<'stripe' | 'xendit'>('stripe')

  useEffect(() => {
    async function checkAuth() {
      // Accept auth token passed via URL hash (cross-domain handoff from PMS)
      if (typeof window !== 'undefined' && window.location.hash) {
        const params = new URLSearchParams(window.location.hash.slice(1))
        const token = params.get('token')
        const expiresAt = params.get('expires_at')
        const userData = params.get('user')
        const fromPms = params.get('from') === 'pms'
        if (fromPms) {
          localStorage.setItem('setup_from', 'pms')
        }
        if (token && expiresAt) {
          localStorage.setItem('access_token', token)
          localStorage.setItem('token_expires_at', expiresAt)
          if (userData) {
            try {
              const user = JSON.parse(decodeURIComponent(userData))
              localStorage.setItem('isLoggedIn', 'true')
              localStorage.setItem('userId', user.id)
              localStorage.setItem('userEmail', user.email)
              localStorage.setItem('userName', user.name)
              localStorage.setItem('userType', user.type)
              localStorage.setItem('userStatus', user.status)
              localStorage.setItem('user', JSON.stringify(user))
            } catch { /* ignore */ }
          }
          // Clean the hash from the URL
          window.history.replaceState(null, '', window.location.pathname)
        }
      }

      if (!authService.isLoggedIn() || !authService.isHotelAdmin()) {
        router.replace('/login')
        return
      }

      // Multi-hotel "Add Property" flow: the header's Add Property
      // button routes to /setup?mode=add for users who already have
      // >= 1 hotel. Skip the setup_complete redirect in that case
      // — the user explicitly came here to create a NEW property.
      // Also clear any stale selectedHotelId so the wizard's first
      // API call (POST /admin/hotels) doesn't accidentally carry an
      // X-Hotel-Id header pointing at an existing hotel.
      const urlParams = typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search)
        : null
      const addMode = urlParams?.get('mode') === 'add'
      if (addMode) {
        try { localStorage.removeItem('selectedHotelId') } catch {}
      }

      const status = await checkSetupStatus()
      if (status?.setup_complete && !addMode) {
        localStorage.setItem('setupComplete', 'true')
        router.replace('/dashboard')
        return
      }
      // In add mode we intentionally DON'T prefill from the existing
      // setup — the user is creating a fresh property, so start blank.
      if (!addMode) {
        const prefill = status?.prefill_data
        if (prefill) {
          if (prefill.property_name) setPropertyName(prefill.property_name)
          if (prefill.reservation_email) setReservationEmail(prefill.reservation_email)
          if (prefill.phone_number) setPhoneNumber(prefill.phone_number)
          if (prefill.address) setAddress(prefill.address)
          if (prefill.hero_image) setHeroImage(prefill.hero_image)
          setPrefilled(true)
        }
      }
      setLoading(false)
    }
    checkAuth()
  }, [router])

  // Sync room and addon currency to property currency.
  // The property currency is the single source of truth in setup —
  // rooms/addons must always follow it, otherwise prices entered by
  // the user in the visible currency get stored under a stale currency
  // and then double-converted when the booking engine displays them.
  useEffect(() => {
    setRooms(prev => prev.map(r => ({ ...r, currency })))
    setSetupAddons(prev => prev.map(a => ({ ...a, currency })))
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
      return !!(primaryColor && selectedFont && heroImage.trim())
    }
    if (step === 3) {
      return !!selectedPms
    }
    if (step === 4) {
      return rooms.every(r =>
        !!(r.name.trim() && r.maxOccupancy >= 1 && r.totalRooms >= 1) &&
        r.seasons.some(s => s.rate && Number(s.rate) > 0) &&
        !hasSeasonCoverageGaps(r)
      )
    }
    if (step === 5) {
      return true // add-ons are optional
    }
    if (step === 6) {
      return true // promo codes are optional
    }
    if (step === 7) {
      return true
    }
    return false
  }

  const handleComplete = async () => {
    setError('')
    setSaving(true)
    try {
      // Clear any stale hotel selection so the explicit create below
      // doesn't accidentally carry an X-Hotel-Id header pointing at
      // some other hotel.
      localStorage.removeItem('selectedHotelId')
      const failedRooms: string[] = []

      const propertyPayload = {
        property_name: propertyName,
        reservation_email: reservationEmail,
        phone_number: phoneNumber,
        whatsapp_number: whatsapp,
        address,
        city,
        country,
        instagram,
        facebook,
        tiktok,
        youtube,
        default_currency: currency,
        default_language: defaultLanguage,
        supported_currencies: supportedCurrencies,
        supported_languages: supportedLanguages,
        check_in_time: checkInFrom,
        check_out_time: checkOutUntil,
        check_in_from: checkInFrom,
        check_in_until: checkInUntil,
        check_out_from: checkOutFrom,
        check_out_until: checkOutUntil,
        pay_at_property_enabled: payAtHotel,
        online_card_payment: onlineCardPayment,
        bank_transfer: bankTransfer,
        payout_account_holder: payoutAccountHolder,
        payout_iban: payoutIban,
        payout_bank_name: payoutBankName,
        payout_swift: payoutSwift,
        special_requests_enabled: specialRequests,
        arrival_time_enabled: estimatedArrivalTime,
        guest_count_enabled: numberOfGuests,
        refer_a_guest_enabled: enableReferAGuest,
      }

      // 1. Explicitly create a new hotel (multi-hotel-safe). This
      // returns the new hotel's id, which we immediately persist so
      // every subsequent step in the wizard carries the right
      // X-Hotel-Id header and the PMS register call gets the same id
      // as the booking-engine row.
      const savedSettings = await settingsService.createHotel(propertyPayload)
      if (savedSettings?.id) {
        localStorage.setItem('selectedHotelId', savedSettings.id)
      }

      // 2. Save design settings
      await settingsService.updateDesignSettings({
        primary_color: primaryColor,
        font_pairing: selectedFont,
        hero_image: heroImage,
        hero_subtext: propertyDescription,
        booking_filters: bookingFilters,
      })

      // 3. Register hotel in PMS with the SAME id as booking-engine
      if (selectedPms === 'vayada') {
        const pmsSlug = savedSettings?.slug || propertyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        try {
          await pmsClient.post('/admin/register-hotel', {
            name: propertyName,
            slug: pmsSlug,
            contactEmail: reservationEmail,
            // Passing the booking_hotel_id unifies the PMS and booking
            // engine ids for this hotel. Without it, PMS would
            // generate its own UUID and we'd be back to the two-id
            // problem the multi-hotel migration was built to fix.
            bookingHotelId: savedSettings?.id,
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
              category: r.category,
              bedType: bedSummary,
              maxOccupancy: r.maxOccupancy,
              bedrooms: r.bedrooms,
              bathrooms: r.bathrooms,
              size: r.roomSize ? Number(r.roomSize) : 0,
              totalRooms: r.totalRooms,
              description: r.description,
              baseRate: Number(r.baseRate) || (r.seasons.length > 0 ? Number(r.seasons[0].rate) || 0 : 0),
              nonRefundableRate: r.nonRefundableRate ? Number(r.nonRefundableRate) : undefined,
              nonRefundableEnabled: r.nonRefundableEnabled,
              nonRefundableDiscount: r.nonRefundableEnabled && r.flexibleRateEnabled ? r.nonRefundableDiscount : undefined,
              currency: r.currency || currency,
              images: r.images,
              amenities: r.amenities,
              features: r.features,
              operatingPeriods: r.operatingPeriods,
              seasons: r.seasons,
              weekendSurcharge: r.weekendSurcharge,
              minimumAdvanceDays: r.minimumAdvanceDays ?? 0,
              cancellationPolicy: r.cancellationPolicy,
              flexibleRateEnabled: r.flexibleRateEnabled,
            })
          } catch {
            failedRooms.push(r.name)
          }
        }

        if (failedRooms.length > 0) {
          console.warn('Some rooms failed to create:', failedRooms)
        }

        // 5. Save payment settings
        try {
          await pmsClient.patch('/admin/payment-settings', {
            payAtPropertyEnabled: payAtHotel,
            onlineCardPayment: onlineCardPayment,
            bankTransfer: bankTransfer,
            paymentProvider: paymentProvider,
            defaultCurrency: currency,
          })
        } catch {
          // Non-fatal
        }
      }

      // 6. Create add-ons
      for (const addon of setupAddons) {
        try {
          await settingsService.createAddon({
            name: addon.name,
            description: addon.description,
            price: addon.price,
            currency: addon.currency,
            category: addon.category,
            image: addon.image,
            duration: addon.duration || undefined,
            perPerson: addon.perPerson,
            perNight: addon.perNight,
          })
        } catch {
          // Non-fatal: addons can be added later from Booking Flow settings
        }
      }

      // 7. Create promo codes
      for (const promo of setupPromoCodes) {
        try {
          await settingsService.createPromoCode({
            code: promo.code,
            discountType: promo.discountType,
            discountValue: promo.discountValue,
            validFrom: promo.validFrom,
            validUntil: promo.validUntil,
            isActive: promo.isActive,
            maxUses: promo.maxUses,
          })
        } catch {
          // Non-fatal: promo codes can be added later from Booking Flow settings
        }
      }

      // 8. Save benefits
      if (benefits.length > 0) {
        try {
          await settingsService.updateBenefits(benefits)
        } catch {
          // Non-fatal: benefits can be added later from Settings
        }
        if (selectedPms === 'vayada') {
          try {
            await pmsClient.put('/admin/benefits', { benefits })
          } catch {
            // Non-fatal: PMS sync may fail if not using vayada PMS
          }
        }
      }

      // Auto-select the newly created hotel
      const hotelList = await settingsService.listHotels()
      if (hotelList.length > 0) {
        const newHotel = hotelList[hotelList.length - 1]
        localStorage.setItem('selectedHotelId', newHotel.id)
      }

      // Store warning about failed rooms so dashboard can show it
      if (failedRooms.length > 0) {
        localStorage.setItem('setupWarning', `Some rooms could not be created: ${failedRooms.join(', ')}. You can add them manually from the dashboard.`)
      }

      localStorage.setItem('setupComplete', 'true')

      // Mark invite code as redeemed
      if (appliedInviteCode) {
        try {
          const token = localStorage.getItem('access_token')
          await fetch(`${MARKETPLACE_API_URL}/api/invite-codes/${appliedInviteCode}/redeem`, {
            method: 'POST',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          })
        } catch { /* non-critical */ }
      }

      // If the user came from PMS, redirect back there
      const fromPms = localStorage.getItem('setup_from') === 'pms'
      if (fromPms) {
        localStorage.removeItem('setup_from')
        const pmsUrl = process.env.NEXT_PUBLIC_PMS_FRONTEND_URL || 'https://pms.vayada.com'
        window.location.href = `${pmsUrl}/dashboard`
        return
      }

      router.push('/dashboard')
    } catch (err: unknown) {
      console.error('Setup failed:', err)
      let message = 'An unexpected error occurred. Please try again.'
      if (err && typeof err === 'object' && 'data' in err) {
        const apiErr = err as { data: { detail: string | Array<{ msg: string }> } }
        if (typeof apiErr.data.detail === 'string') {
          message = apiErr.data.detail
        } else if (Array.isArray(apiErr.data.detail)) {
          message = apiErr.data.detail.map(e => e.msg).join(', ')
        }
      } else if (err instanceof TypeError && err.message === 'Failed to fetch') {
        message = 'Could not connect to the server. Please check your internet connection and try again.'
      } else if (err instanceof Error) {
        message = err.message
      }
      setError(message)
      setSaving(false)
    }
  }

  const stepIndicators = (
    <div className="flex items-center justify-center mb-6 sm:mb-8">
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
                idx + 1
              )}
            </div>
            <span className={`hidden sm:inline text-[12px] font-medium whitespace-nowrap ${
              step >= s.number ? 'text-gray-900' : 'text-gray-400'
            }`}>
              {s.label}
            </span>
          </div>
          {idx < STEPS.length - 1 && (
            <div className={`w-6 sm:w-12 h-px mx-2 sm:mx-3 shrink-0 ${step > s.number ? 'bg-primary-500' : 'bg-gray-300'}`} />
          )}
        </div>
      ))}
    </div>
  )

  const MARKETPLACE_API_URL = process.env.NEXT_PUBLIC_MARKETPLACE_API_URL || 'https://api.vayada.com'

  const applyInviteCode = async () => {
    if (!inviteCode.trim()) return
    setInviteError('')
    setApplyingInvite(true)
    try {
      const res = await fetch(`${MARKETPLACE_API_URL}/api/invite-codes/${inviteCode.trim().toUpperCase()}`)
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setInviteError(err.detail || 'Invalid invite code')
        setApplyingInvite(false)
        return
      }
      const { data } = await res.json()

      // Prefill property
      if (data.property) {
        const p = data.property
        if (p.property_name) setPropertyName(p.property_name)
        if (p.city) setCity(p.city)
        if (p.country) setCountry(p.country)
        if (p.address) setAddress(p.address)
        if (p.reservation_email) setReservationEmail(p.reservation_email)
        if (p.phone_number) setPhoneNumber(p.phone_number)
        if (p.whatsapp_number) setWhatsapp(p.whatsapp_number)
        if (p.instagram) setInstagram(p.instagram)
        if (p.facebook) setFacebook(p.facebook)
        if (p.tiktok) setTiktok(p.tiktok)
        if (p.youtube) setYoutube(p.youtube)
        if (p.default_currency) setCurrency(p.default_currency)
        if (p.default_language) setDefaultLanguage(p.default_language)
        if (p.supported_currencies) setSupportedCurrencies(p.supported_currencies)
        if (p.supported_languages) setSupportedLanguages(p.supported_languages)
      }

      // Prefill branding
      if (data.branding) {
        const b = data.branding
        if (b.hero_image) setHeroImage(b.hero_image)
        if (b.primary_color) setPrimaryColor(b.primary_color)
        if (b.font_pairing) setSelectedFont(b.font_pairing)
        if (b.description) setPropertyDescription(b.description)
        if (b.booking_filters) setBookingFilters(b.booking_filters)
      }

      // Prefill rooms
      if (data.rooms && data.rooms.length > 0) {
        setRooms(data.rooms.map((r: any) => ({
          ...createEmptyRoom(),
          ...r,
          currency: r.currency || data.property?.default_currency || 'EUR',
        })))
      }

      // Prefill addons
      if (data.addons && data.addons.length > 0) {
        setSetupAddons(data.addons.map((a: any) => ({
          _localId: crypto.randomUUID(),
          name: a.name || '',
          description: a.description || '',
          price: a.price || 0,
          currency: a.currency || data.property?.default_currency || 'EUR',
          category: a.category || 'experience',
          image: a.image || '',
          duration: a.duration || '',
          perPerson: a.perPerson || false,
          perNight: a.perNight || false,
        })))
      }

      // Prefill promo codes
      if (data.promoCodes && data.promoCodes.length > 0) {
        setSetupPromoCodes(data.promoCodes.map((p: any) => ({
          _localId: crypto.randomUUID(),
          code: p.code || '',
          discountType: p.discountType || 'percentage',
          discountValue: p.discountValue || 0,
          validFrom: p.validFrom || null,
          validUntil: p.validUntil || null,
          isActive: p.isActive !== undefined ? p.isActive : true,
          maxUses: p.maxUses ?? null,
        })))
      }

      // Prefill benefits
      if (data.benefits && data.benefits.length > 0) {
        setBenefits(data.benefits)
      }

      // Prefill policies
      if (data.policies) {
        const pol = data.policies
        if (pol.check_in_from) setCheckInFrom(pol.check_in_from)
        else if (pol.check_in_time) setCheckInFrom(pol.check_in_time)
        if (pol.check_in_until) setCheckInUntil(pol.check_in_until)
        if (pol.check_out_from) setCheckOutFrom(pol.check_out_from)
        if (pol.check_out_until) setCheckOutUntil(pol.check_out_until)
        else if (pol.check_out_time) setCheckOutUntil(pol.check_out_time)
        if (pol.pay_at_property !== undefined) setPayAtHotel(pol.pay_at_property)
        if (pol.online_card_payment !== undefined) setOnlineCardPayment(pol.online_card_payment)
        if (pol.bank_transfer !== undefined) setBankTransfer(pol.bank_transfer)
        if (pol.special_requests !== undefined) setSpecialRequests(pol.special_requests)
        if (pol.arrival_time !== undefined) setEstimatedArrivalTime(pol.arrival_time)
        if (pol.guest_count !== undefined) setNumberOfGuests(pol.guest_count)
        if (pol.refer_a_guest !== undefined) setEnableReferAGuest(pol.refer_a_guest)
      }

      // Prefill payment provider from internal settings
      if (data.internal?.payment_provider) {
        setPaymentProvider(data.internal.payment_provider)
      }

      setAppliedInviteCode(inviteCode.trim().toUpperCase())
      setPrefilled(true)
      setShowWizard(true)
    } catch {
      setInviteError('Failed to fetch invite data. Please try again.')
    } finally {
      setApplyingInvite(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  // Welcome screen with invite code option
  if (!showWizard && !prefilled) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col">
        <div className="bg-white border-b border-gray-200 px-4 sm:px-8 py-3 shrink-0">
          <div className="flex items-center gap-2.5">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect width="32" height="32" rx="6" fill="#4338CA" />
              <path d="M10 16.5L14 20.5L22 12.5" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="font-semibold text-gray-900 text-[15px]">Property Setup</span>
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center px-4">
          <div className="max-w-md w-full space-y-6">
            <div className="text-center">
              <h1 className="text-2xl font-bold text-gray-900 mb-2">Welcome to vayada</h1>
              <p className="text-sm text-gray-500">Set up your property in just a few minutes</p>
            </div>

            {/* Invite Code */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="text-[14px] font-semibold text-gray-900 mb-1">Have an invite code?</h2>
              <p className="text-[12px] text-gray-500 mb-4">If vayada pre-configured your property, enter the code to load everything.</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={inviteCode}
                  onChange={e => { setInviteCode(e.target.value.toUpperCase()); setInviteError('') }}
                  placeholder="e.g. A7K3-X9M2"
                  className="flex-1 px-3 py-2.5 border border-gray-300 rounded-lg text-[14px] font-mono tracking-wider focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  onKeyDown={e => { if (e.key === 'Enter') applyInviteCode() }}
                />
                <button
                  onClick={applyInviteCode}
                  disabled={applyingInvite || !inviteCode.trim()}
                  className="px-5 py-2.5 bg-primary-600 text-white text-[13px] font-semibold rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
                >
                  {applyingInvite ? 'Loading...' : 'Apply'}
                </button>
              </div>
              {inviteError && <p className="text-[12px] text-red-600 mt-2">{inviteError}</p>}
            </div>

            {/* Divider */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-gray-200" />
              <span className="text-[12px] text-gray-400 font-medium">or</span>
              <div className="flex-1 h-px bg-gray-200" />
            </div>

            {/* Start from scratch */}
            <button
              onClick={() => setShowWizard(true)}
              className="w-full py-3 bg-white border border-gray-300 text-gray-900 text-[14px] font-semibold rounded-xl hover:bg-gray-50 transition-colors"
            >
              Set up manually
            </button>
          </div>
        </div>

        {/* Sign out */}
        <div className="fixed bottom-6 left-6">
          <button
            onClick={() => authService.logout()}
            className="text-[13px] text-gray-400 hover:text-gray-600 transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="stylesheet" href={GOOGLE_FONTS_URL} />

      {/* Top bar */}
      <div className="bg-white border-b border-gray-200 px-4 sm:px-8 py-3 shrink-0">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect width="32" height="32" rx="6" fill="#4338CA" />
              <path d="M10 16.5L14 20.5L22 12.5" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="font-semibold text-gray-900 text-[15px]">Property Setup</span>
          </div>
          <span className="text-[12px] sm:text-[13px] text-gray-500 whitespace-nowrap">Step {STEPS.findIndex(s => s.number === step) + 1} of {STEPS.length}</span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-[3px] bg-gray-100 shrink-0">
        <div
          className="h-full bg-primary-600 transition-all duration-300"
          style={{ width: `${((STEPS.findIndex(s => s.number === step) + 1) / STEPS.length) * 100}%` }}
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
          tiktok={tiktok} setTiktok={setTiktok}
          youtube={youtube} setYoutube={setYoutube}
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
          onContinue={() => { setError(''); setStep(4) }}
          stepIndicators={stepIndicators}
        />
      )}

      {/* Step 3 (PMS selection) hidden — only vayada PMS for now. Re-enable when more PMS options are available. */}

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
          roomFileInputRef={roomFileInputRef}
          uploadingRoomImages={uploadingRoomImages}
          handleRoomImageUpload={handleRoomImageUpload}
          currency={currency}
          error={error}
          canProceed={canProceed()}
          onBack={() => setStep(2)}
          onContinue={() => { setError(''); setStep(5) }}
          stepIndicators={stepIndicators}
        />
      )}

      {step === 5 && (
        <AddonsStep
          addons={setupAddons}
          setAddons={setSetupAddons}
          currency={currency}
          error={error}
          canProceed={canProceed()}
          onBack={() => setStep(4)}
          onContinue={() => { setError(''); setStep(7) }}
          stepIndicators={stepIndicators}
        />
      )}

      {/* Step 6 (Promo Codes) hidden — can be re-enabled later */}

      {step === 7 && (
        <BenefitsStep
          benefits={benefits}
          setBenefits={setBenefits}
          error={error}
          canProceed={canProceed()}
          onBack={() => setStep(5)}
          onContinue={() => { setError(''); setStep(8) }}
          stepIndicators={stepIndicators}
        />
      )}

      {step === 8 && (
        <PoliciesStep
          checkInFrom={checkInFrom} setCheckInFrom={setCheckInFrom}
          checkInUntil={checkInUntil} setCheckInUntil={setCheckInUntil}
          checkOutFrom={checkOutFrom} setCheckOutFrom={setCheckOutFrom}
          checkOutUntil={checkOutUntil} setCheckOutUntil={setCheckOutUntil}
          payAtHotel={payAtHotel} setPayAtHotel={setPayAtHotel}
          payAtHotelMethods={payAtHotelMethods} setPayAtHotelMethods={setPayAtHotelMethods}
          onlineCardPayment={onlineCardPayment} setOnlineCardPayment={setOnlineCardPayment}
          bankTransfer={bankTransfer} setBankTransfer={setBankTransfer}
          payoutAccountHolder={payoutAccountHolder} setPayoutAccountHolder={setPayoutAccountHolder}
          payoutIban={payoutIban} setPayoutIban={setPayoutIban}
          payoutBankName={payoutBankName} setPayoutBankName={setPayoutBankName}
          payoutSwift={payoutSwift} setPayoutSwift={setPayoutSwift}
          specialRequests={specialRequests} setSpecialRequests={setSpecialRequests}
          estimatedArrivalTime={estimatedArrivalTime} setEstimatedArrivalTime={setEstimatedArrivalTime}
          numberOfGuests={numberOfGuests} setNumberOfGuests={setNumberOfGuests}
          enableReferAGuest={enableReferAGuest} setEnableReferAGuest={setEnableReferAGuest}
          error={error}
          saving={saving}
          onBack={() => setStep(7)}
          onComplete={handleComplete}
          stepIndicators={stepIndicators}
        />
      )}
    </div>
  )
}
