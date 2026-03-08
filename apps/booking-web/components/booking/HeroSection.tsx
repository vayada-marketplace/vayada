import Image from 'next/image'
import BookingNavigation from '@/components/layout/BookingNavigation'

interface HeroSectionProps {
  heroImage: string
  hotelName: string
  description?: string
  compact?: boolean
}

export default function HeroSection({ heroImage, hotelName, description, compact }: HeroSectionProps) {
  if (compact) {
    return (
      <div className="relative h-32 w-full">
        <Image src={heroImage} alt={hotelName} fill className="object-cover" priority quality={90} sizes="100vw" />
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 to-black/60" />
        <BookingNavigation />
      </div>
    )
  }

  return (
    <div className="relative h-[420px] w-full">
      <Image
        src={heroImage}
        alt={hotelName}
        fill
        className="object-cover"
        priority
        quality={90}
        sizes="100vw"
      />
      <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-black/60" />
      <BookingNavigation />
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">
        <h1 className="text-5xl md:text-6xl lg:text-7xl font-heading italic text-white mb-4">
          {hotelName}
        </h1>
        {description && (
          <p className="text-white/90 text-lg md:text-xl max-w-2xl leading-relaxed">
            {description}
          </p>
        )}
      </div>
    </div>
  )
}
