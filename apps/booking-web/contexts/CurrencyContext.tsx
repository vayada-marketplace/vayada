'use client'

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react'
import { useHotel } from '@/contexts/HotelContext'
import { apiClient } from '@/services/api/client'

interface CurrencyContextValue {
  selectedCurrency: string
  setSelectedCurrency: (currency: string) => void
  rates: Record<string, number>
  loading: boolean
  convertPrice: (amount: number, fromCurrency: string) => number
  formatPrice: (amount: number, fromCurrency: string) => string
}

const CurrencyContext = createContext<CurrencyContextValue>({
  selectedCurrency: 'EUR',
  setSelectedCurrency: () => {},
  rates: {},
  loading: true,
  convertPrice: (amount) => amount,
  formatPrice: (amount) => String(amount),
})

const STORAGE_KEY = 'vayada-selected-currency'

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const { hotel } = useHotel()
  const baseCurrency = hotel?.currency || 'EUR'

  const [selectedCurrency, setSelectedCurrencyState] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(STORAGE_KEY) || baseCurrency
    }
    return baseCurrency
  })
  const [rates, setRates] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)

  // Sync default currency when hotel loads
  useEffect(() => {
    if (!hotel) return
    const stored = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    if (!stored) {
      setSelectedCurrencyState(hotel.currency)
    }
  }, [hotel])

  // Fetch exchange rates
  useEffect(() => {
    if (!baseCurrency) return
    setLoading(true)
    apiClient
      .get<{ base: string; rates: Record<string, number> }>(
        `/api/exchange-rates?base=${baseCurrency}`
      )
      .then((data) => {
        setRates(data.rates)
        setLoading(false)
      })
      .catch(() => {
        setLoading(false)
      })
  }, [baseCurrency])

  const setSelectedCurrency = useCallback((currency: string) => {
    setSelectedCurrencyState(currency)
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, currency)
    }
  }, [])

  const convertPrice = useCallback(
    (amount: number, fromCurrency: string): number => {
      if (fromCurrency === selectedCurrency) return amount
      // fromCurrency -> baseCurrency -> selectedCurrency
      let amountInBase = amount
      if (fromCurrency !== baseCurrency) {
        const fromRate = rates[fromCurrency]
        if (fromRate) {
          amountInBase = amount / fromRate
        }
      }
      if (selectedCurrency === baseCurrency) return amountInBase
      const toRate = rates[selectedCurrency]
      if (toRate) return amountInBase * toRate
      return amount
    },
    [selectedCurrency, baseCurrency, rates]
  )

  const formatPrice = useCallback(
    (amount: number, fromCurrency: string): string => {
      const converted = convertPrice(amount, fromCurrency)
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: selectedCurrency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(converted)
    },
    [convertPrice, selectedCurrency]
  )

  return (
    <CurrencyContext.Provider
      value={{
        selectedCurrency,
        setSelectedCurrency,
        rates,
        loading,
        convertPrice,
        formatPrice,
      }}
    >
      {children}
    </CurrencyContext.Provider>
  )
}

export function useCurrency() {
  return useContext(CurrencyContext)
}
