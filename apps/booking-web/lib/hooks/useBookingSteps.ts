'use client'

import { useTranslations } from 'next-intl'
import { useAddons } from '@/contexts/HotelContext'

export type BookingStepName = 'rooms' | 'addons' | 'details' | 'payment'

export interface BookingStep {
  number: number
  label: string
  name: BookingStepName
}

/**
 * Single source of truth for the booking-flow stepper. Hides the "Add-ons"
 * step automatically when the hotel has none. Pass the conceptual current
 * step name; the returned `currentStep` adjusts to the visible numbering.
 */
export function useBookingSteps(current: BookingStepName) {
  const t = useTranslations('steps')
  const { addons } = useAddons()
  const hasAddons = addons.length > 0

  const steps: BookingStep[] = hasAddons
    ? [
        { number: 1, label: t('rooms'), name: 'rooms' },
        { number: 2, label: t('addons'), name: 'addons' },
        { number: 3, label: t('details'), name: 'details' },
        { number: 4, label: t('payment'), name: 'payment' },
      ]
    : [
        { number: 1, label: t('rooms'), name: 'rooms' },
        { number: 2, label: t('details'), name: 'details' },
        { number: 3, label: t('payment'), name: 'payment' },
      ]

  const currentStep = steps.find((s) => s.name === current)?.number ?? 1
  return { steps, currentStep, hasAddons }
}
