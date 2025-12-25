'use client'

import { useState, useRef, useEffect } from 'react'
import { Input } from './Input'

// Common countries list
const COUNTRIES = [
  'Afghanistan', 'Albania', 'Algeria', 'Argentina', 'Australia', 'Austria',
  'Bangladesh', 'Belgium', 'Brazil', 'Bulgaria', 'Canada', 'Chile', 'China',
  'Colombia', 'Croatia', 'Czech Republic', 'Denmark', 'Egypt', 'Finland',
  'France', 'Germany', 'Greece', 'Hungary', 'India', 'Indonesia', 'Iran',
  'Ireland', 'Israel', 'Italy', 'Japan', 'Kenya', 'Malaysia', 'Mexico',
  'Morocco', 'Netherlands', 'New Zealand', 'Nigeria', 'Norway', 'Pakistan',
  'Philippines', 'Poland', 'Portugal', 'Romania', 'Russia', 'Saudi Arabia',
  'Singapore', 'South Africa', 'South Korea', 'Spain', 'Sweden', 'Switzerland',
  'Thailand', 'Turkey', 'Ukraine', 'United Arab Emirates', 'United Kingdom',
  'United States', 'Vietnam'
].sort()

interface CountrySelectProps {
  value: string
  onChange: (country: string) => void
  placeholder?: string
  className?: string
}

export function CountrySelect({ value, onChange, placeholder = 'Search countries...', className = '' }: CountrySelectProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  const filteredCountries = COUNTRIES.filter(country =>
    country.toLowerCase().includes(searchTerm.toLowerCase())
  )

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
        if (!value) {
          setSearchTerm('')
        }
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [value])

  useEffect(() => {
    if (value) {
      setSearchTerm('')
    }
  }, [value])

  const handleSelect = (country: string) => {
    onChange(country)
    setIsOpen(false)
    setSearchTerm('')
  }

  const displayValue = isOpen ? searchTerm : (value || '')

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <Input
        placeholder={placeholder}
        value={displayValue}
        onChange={(e) => {
          const inputValue = e.target.value
          setSearchTerm(inputValue)
          setIsOpen(true)
          // Clear value if user is typing something new
          if (value && inputValue !== value) {
            onChange('')
          }
        }}
        onFocus={() => {
          setIsOpen(true)
          setSearchTerm(value || '')
        }}
        className="w-full"
      />
      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-auto">
          {filteredCountries.length > 0 ? (
            filteredCountries.map((country) => (
              <button
                key={country}
                type="button"
                onClick={() => handleSelect(country)}
                className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-blue-50 focus:bg-blue-50 focus:outline-none"
              >
                {country}
              </button>
            ))
          ) : (
            <div className="px-4 py-2 text-sm text-gray-500">No countries found</div>
          )}
        </div>
      )}
    </div>
  )
}

