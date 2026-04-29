'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAddons, useHotel, useRooms, useSlug } from '@/contexts/HotelContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { calculateNights } from '@/lib/utils'
import { calculatePromoDiscount, getNonRefundableRate } from '@/lib/constants/booking'
import { hotelService } from '@/services/api/hotel'

export interface PromoDiscount {
  type: string
  /** The raw discount value as returned by the backend (in hotel currency for fixed, percent for percentage). */
  value: number
  /** The discount applied to the current subtotal, already in the displayed currency. */
  amount: number
}

export interface PricingInputs {
  roomId: string
  checkIn: string
  checkOut: string
  rateType: string
  roomsParam: number
  selectedAddonIds: string[]
  addonQuantities: Record<string, number>
  promoCode: string
}

// Cache promo lookups across pages so navigating book → payment doesn't re-hit
// the backend with the same code (and ensures both pages agree on the result).
const promoCache = new Map<string, Promise<{
  valid: boolean
  discountType?: string
  discountValue?: number
}>>()

function fetchPromo(slug: string, code: string) {
  const key = `${slug}:${code}`
  let p = promoCache.get(key)
  if (!p) {
    p = hotelService.validatePromoCode(slug, code).catch(() => ({ valid: false }))
    promoCache.set(key, p)
  }
  return p
}

export function usePricing({
  roomId,
  checkIn,
  checkOut,
  rateType,
  roomsParam,
  selectedAddonIds,
  addonQuantities,
  promoCode,
}: PricingInputs) {
  const { hotel } = useHotel()
  const { rooms } = useRooms()
  const { addons } = useAddons()
  const { slug } = useSlug()
  const { convertAndRound } = useCurrency()

  const room = rooms.find((r) => r.id === roomId) || rooms[0]
  const nights = calculateNights(checkIn, checkOut)
  const roomCurrency = room?.currency || hotel?.currency || 'EUR'

  // Per-night rate rounded in the displayed currency so nightly × nights equals
  // the shown total (avoids "$25 × 3 = $76" conversion rounding mismatch).
  const nightlyRateBase = rateType === 'nonrefundable'
    ? getNonRefundableRate(room?.baseRate ?? 0, room?.nonRefundableRate)
    : room?.baseRate ?? 0
  const nightlyRate = room ? convertAndRound(nightlyRateBase, roomCurrency) : 0
  const roomTotal = nightlyRate * nights * roomsParam

  // Sum addon line totals in the displayed currency. Each line is rounded
  // first so its shown price matches its contribution.
  const selectedKey = selectedAddonIds.join(',')
  const quantitiesKey = JSON.stringify(addonQuantities)
  const addonTotal = useMemo(() => {
    let total = 0
    for (const addon of addons) {
      if (!selectedAddonIds.includes(addon.id)) continue
      const qty = addon.perNight
        ? (addonQuantities[addon.id] ?? nights)
        : (addonQuantities[addon.id] ?? 1)
      total += convertAndRound(addon.price * qty, addon.currency)
    }
    return total
    // selectedKey/quantitiesKey are stable identity proxies for the inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addons, selectedKey, quantitiesKey, nights, convertAndRound])

  const [promoDiscount, setPromoDiscount] = useState<PromoDiscount | null>(null)
  useEffect(() => {
    if (!promoCode || !slug) {
      setPromoDiscount(null)
      return
    }
    let cancelled = false
    fetchPromo(slug, promoCode).then((res) => {
      if (cancelled) return
      if (!res.valid || !res.discountType || res.discountValue == null) {
        setPromoDiscount(null)
        return
      }
      const subtotal = roomTotal + addonTotal
      // Fixed-amount promos are stored in the hotel's base currency; convert to
      // the displayed currency so the discount matches the shown subtotal.
      const value = res.discountType === 'fixed'
        ? convertAndRound(res.discountValue, roomCurrency)
        : res.discountValue
      const amount = calculatePromoDiscount(subtotal, res.discountType, value)
      setPromoDiscount({ type: res.discountType, value: res.discountValue, amount })
    })
    return () => { cancelled = true }
  }, [promoCode, slug, roomTotal, addonTotal, roomCurrency, convertAndRound])

  const discountAmount = promoDiscount?.amount ?? 0
  const grandTotal = roomTotal + addonTotal - discountAmount

  return {
    room,
    nights,
    roomCurrency,
    nightlyRate,
    roomTotal,
    addonTotal,
    promoDiscount,
    discountAmount,
    grandTotal,
  }
}
