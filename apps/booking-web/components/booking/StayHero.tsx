import type { ReactNode } from "react";
import HotelHeroImage from "@/components/booking/HotelHeroImage";

/**
 * The top of a booking page (VAY-2448): its photo, about 55% of the window and 400–640px tall,
 * the page's navigation over it, and its heading and line in the middle. Shared by a hotel's page
 * and an agency's (VAY-2459).
 *
 * On phones (VAY-2494, Timo's "Proposal – Card overlaps hero") it is 420px tall and the search
 * card overlaps its last 64px. The heading and line sit low, 28px above the card, on a photo
 * darkened at the top and the bottom; its last 80px fade into the page, so no dark strips show
 * left and right of the card.
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
    <div className="relative h-[clamp(400px,55vh,640px)] w-full max-md:h-[420px]">
      <HotelHeroImage src={image} alt={alt} quality={90} sizes="100vw" />
      <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-black/60 max-md:bg-[linear-gradient(180deg,rgba(20,15,10,0.5)_0%,rgba(20,15,10,0.1)_35%,rgba(20,15,10,0.15)_60%,rgba(20,15,10,0.6)_100%)]" />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-b from-transparent to-white md:hidden"
      />

      {navigation}

      {/* Hero Content */}
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4 max-md:justify-end max-md:px-6 max-md:pb-[92px]">
        <h1 className="text-5xl md:text-6xl lg:text-7xl font-heading italic text-white mb-4 max-md:mb-2.5 max-md:text-[44px]">
          {heading}
        </h1>
        {/* The hero can be 400px: a long description stays clear of the search card. */}
        <p className="text-white/90 text-lg md:text-xl max-w-2xl leading-relaxed line-clamp-3 max-md:text-[17px] max-md:leading-snug">
          {subtext}
        </p>
      </div>
    </div>
  );
}
