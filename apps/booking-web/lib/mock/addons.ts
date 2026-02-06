export interface Addon {
  id: string
  name: string
  description: string
  price: number
  currency: string
  category: 'transfers' | 'wellness' | 'experiences' | 'dining'
  image: string
}

export const ADDON_CATEGORIES = [
  { key: 'all', label: 'All Services' },
  { key: 'transfers', label: 'Transfers' },
  { key: 'wellness', label: 'Wellness' },
  { key: 'experiences', label: 'Experiences' },
  { key: 'dining', label: 'Dining' },
] as const

export const MOCK_ADDONS: Addon[] = [
  {
    id: 'addon-1',
    name: 'Airport Transfer',
    description: 'Premium private airport transfer service with meet & greet',
    price: 80,
    currency: 'EUR',
    category: 'transfers',
    image: 'https://images.unsplash.com/photo-1449965408869-eaa3f722e40d?w=600&q=80',
  },
  {
    id: 'addon-2',
    name: 'Guided Mountain Hike',
    description: 'Full-day guided hike through the stunning Nordkette mountain range',
    price: 120,
    currency: 'EUR',
    category: 'experiences',
    image: 'https://images.unsplash.com/photo-1551632811-561732d1e306?w=600&q=80',
  },
  {
    id: 'addon-3',
    name: 'Ski Pass Bundle',
    description: 'Full-day ski pass for all Innsbruck ski resorts with equipment rental',
    price: 95,
    currency: 'EUR',
    category: 'experiences',
    image: 'https://images.unsplash.com/photo-1565992441121-4367c2967103?w=600&q=80',
  },
  {
    id: 'addon-4',
    name: 'Alpine Spa Package',
    description: 'Traditional Alpine massage, herbal bath, and sauna session',
    price: 150,
    currency: 'EUR',
    category: 'wellness',
    image: 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=600&q=80',
  },
  {
    id: 'addon-5',
    name: 'Thermal Bath Experience',
    description: 'Half-day access to premium thermal baths with panoramic mountain views',
    price: 65,
    currency: 'EUR',
    category: 'wellness',
    image: 'https://images.unsplash.com/photo-1540555700478-4be289fbec6d?w=600&q=80',
  },
  {
    id: 'addon-6',
    name: 'Austrian Cooking Class',
    description: 'Learn authentic Tyrolean cuisine with our executive chef',
    price: 85,
    currency: 'EUR',
    category: 'dining',
    image: 'https://images.unsplash.com/photo-1556910103-1c02745aae4d?w=600&q=80',
  },
  {
    id: 'addon-7',
    name: 'Private Wine Tasting',
    description: 'Curated Austrian wine tasting with sommelier and cheese pairing',
    price: 70,
    currency: 'EUR',
    category: 'dining',
    image: 'https://images.unsplash.com/photo-1510812431401-41d2bd2722f3?w=600&q=80',
  },
  {
    id: 'addon-8',
    name: 'Romantic Dinner',
    description: 'Five-course candlelit dinner with mountain views and wine pairing',
    price: 180,
    currency: 'EUR',
    category: 'dining',
    image: 'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=600&q=80',
  },
  {
    id: 'addon-9',
    name: 'City Shuttle Service',
    description: 'On-demand shuttle to Innsbruck Old Town and major attractions',
    price: 25,
    currency: 'EUR',
    category: 'transfers',
    image: 'https://images.unsplash.com/photo-1570125909232-eb263c188f7e?w=600&q=80',
  },
]
