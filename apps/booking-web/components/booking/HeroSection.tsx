import HotelHeroImage from "@/components/booking/HotelHeroImage";
import BookingNavigation from "@/components/layout/BookingNavigation";

/** The hotel's hero above the booking steps, as on the old booking pages (VAY-2195). */
export default function HeroSection({
  heroImage,
  heading,
  subtext,
}: {
  heroImage: string | null;
  heading: string;
  subtext?: string;
}) {
  return (
    <div className="relative h-[300px] md:h-[420px] w-full bg-gray-800">
      <HotelHeroImage src={heroImage} alt="" quality={90} sizes="100vw" />
      <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-black/60" />
      <BookingNavigation />
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">
        <p className="text-5xl md:text-6xl lg:text-7xl font-heading italic text-white mb-4">
          {heading}
        </p>
        {subtext && (
          <p className="text-white/90 text-lg md:text-xl max-w-2xl leading-relaxed">{subtext}</p>
        )}
      </div>
    </div>
  );
}
