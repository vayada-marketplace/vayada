import type { ReactNode } from "react";
import HotelHeroImage from "@/components/booking/HotelHeroImage";

/**
 * The top of a booking page (VAY-2448): its photo, about 55% of the window and 400–640px tall,
 * the page's navigation over it, and its heading and line in the middle. Shared by a hotel's page
 * and an agency's (VAY-2459).
 */
export default function StayHero({
  image,
  alt,
  heading,
  subtext,
  navigation,
}: {
  image: string | null;
  alt: string;
  heading: string;
  subtext: string | null | undefined;
  navigation: ReactNode;
}) {
  return (
    <div className="relative h-[clamp(400px,55vh,640px)] w-full">
      <HotelHeroImage src={image} alt={alt} quality={90} sizes="100vw" />
      <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-black/60" />

      {navigation}

      {/* Hero Content */}
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">
        <h1 className="text-5xl md:text-6xl lg:text-7xl font-heading italic text-white mb-4">
          {heading}
        </h1>
        {/* The hero can be 400px: a long description stays clear of the search card. */}
        <p className="text-white/90 text-lg md:text-xl max-w-2xl leading-relaxed line-clamp-3">
          {subtext}
        </p>
      </div>
    </div>
  );
}
