'use client'

interface Tab {
  label: string
  value: string
}

interface FilterTabsProps {
  tabs: Tab[]
  activeValue: string
  onChange: (value: string) => void
}

export default function FilterTabs({ tabs, activeValue, onChange }: FilterTabsProps) {
  return (
    <div className="flex gap-1 mb-6 bg-gray-100 p-1 rounded-lg w-fit">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          onClick={() => onChange(tab.value)}
          className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
            activeValue === tab.value
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
