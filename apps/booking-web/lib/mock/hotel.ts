import { Hotel } from '@/lib/types'

export const MOCK_HOTEL: Hotel = {
  id: '1',
  name: 'Hotel Alpenrose',
  slug: 'hotel-alpenrose',
  description:
    'A boutique alpine retreat featuring panoramic mountain views, world-class spa facilities, and refined Austrian hospitality in the heart of Innsbruck.',
  location: 'Innsbruck, Austria',
  country: 'Austria',
  starRating: 4,
  currency: 'EUR',
  heroImage: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=1920&q=80',
  images: [
    'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=800&q=80',
    'https://images.unsplash.com/photo-1582719508461-905c673771fd?w=800&q=80',
    'https://images.unsplash.com/photo-1551882547-ff40c63fe5fa?w=800&q=80',
  ],
  amenities: [
    'Free WiFi',
    'Spa & Wellness',
    'Restaurant',
    'Bar & Lounge',
    'Fitness Center',
    'Room Service',
    'Concierge',
    'Airport Shuttle',
    'Ski Storage',
    'Mountain Views',
  ],
  checkInTime: '15:00',
  checkOutTime: '11:00',
  contact: {
    address: 'Alpengasse 12, 6020 Innsbruck, Austria',
    phone: '+43 512 123 456',
    email: 'reservations@hotel-alpenrose.at',
    whatsapp: '+43 512 123 456',
  },
  socialLinks: {
    facebook: 'https://facebook.com/hotelalpenrose',
    instagram: 'https://instagram.com/hotelalpenrose',
  },
  branding: {
    primaryColor: '#1E3EDB',
  },
}
