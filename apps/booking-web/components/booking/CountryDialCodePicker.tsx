'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { COUNTRY_DIAL_CODES, type CountryDialCode } from '@/lib/constants/countryDialCodes'

interface CountryDialCodePickerProps {
  value: string
  onChange: (iso2: string) => void
}

function normalize(s: string): string {
  return s.toLowerCase().trim()
}

function matches(country: CountryDialCode, query: string): boolean {
  if (!query) return true
  const q = normalize(query).replace(/^\+/, '')
  if (!q) return true
  if (normalize(country.name).includes(q)) return true
  if (country.iso2.toLowerCase().includes(q)) return true
  if (country.dial.includes(q)) return true
  return false
}

export default function CountryDialCodePicker({ value, onChange }: CountryDialCodePickerProps) {
  const t = useTranslations('book')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const listboxId = useId()

  const filtered = useMemo(
    () => COUNTRY_DIAL_CODES.filter((c) => matches(c, query)),
    [query],
  )

  const selected = useMemo(
    () => COUNTRY_DIAL_CODES.find((c) => c.iso2 === value) ?? null,
    [value],
  )

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  useEffect(() => {
    if (open) {
      setQuery('')
      setHighlight(0)
      // Defer focus to next tick so the input is in the DOM.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLLIElement>(`[data-index="${highlight}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlight, open])

  const commit = (iso2: string) => {
    onChange(iso2)
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      setHighlight((h) => Math.min(h + 1, Math.max(filtered.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      if (open && filtered[highlight]) {
        e.preventDefault()
        commit(filtered[highlight].iso2)
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault()
        setOpen(false)
      }
    }
  }

  const buttonLabel = selected
    ? `${selected.flag} +${selected.dial}`
    : t('selectCountryCode')

  return (
    <div ref={containerRef} className="relative flex-shrink-0 w-32">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={t('phoneCountryCode')}
        className="w-full h-full px-3 py-3 bg-gray-50 border-r border-gray-300 text-left text-gray-900 focus:outline-none flex items-center justify-between gap-1"
      >
        <span className="truncate">{buttonLabel}</span>
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 20 20"
          fill="none"
          className="flex-shrink-0 text-gray-500"
        >
          <path
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            d="m6 8 4 4 4-4"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute z-20 left-0 top-full mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-300 bg-white shadow-lg">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setHighlight(0)
            }}
            onKeyDown={onKeyDown}
            aria-label={t('searchCountryCode')}
            aria-controls={listboxId}
            aria-activedescendant={
              filtered[highlight] ? `${listboxId}-opt-${filtered[highlight].iso2}` : undefined
            }
            className="sr-only"
          />
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            className="max-h-64 overflow-y-auto py-1"
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-gray-500">
                {t('noCountriesFound')}
              </li>
            ) : (
              filtered.map((c, i) => {
                const isSelected = c.iso2 === value
                const isHighlighted = i === highlight
                return (
                  <li
                    key={c.iso2}
                    id={`${listboxId}-opt-${c.iso2}`}
                    data-index={i}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setHighlight(i)}
                    onMouseDown={(e) => {
                      // Prevent input blur before click registers.
                      e.preventDefault()
                      commit(c.iso2)
                    }}
                    className={`px-3 py-2 text-sm cursor-pointer flex items-center gap-2 ${
                      isHighlighted ? 'bg-primary-50' : ''
                    } ${isSelected ? 'font-semibold text-primary-700' : 'text-gray-900'}`}
                  >
                    <span className="text-base leading-none">{c.flag}</span>
                    <span className="text-gray-500 tabular-nums">+{c.dial}</span>
                    <span className="truncate">{c.name}</span>
                  </li>
                )
              })
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
