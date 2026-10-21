import Image from "next/image";

/**
 * The hotel's hero photo, filling its (relative) parent. A hotel can go live before it has photos
 * (VAY-2247): then a calm slate gradient stands in, so the page never shows a stretched logo or a broken image.
 */
export default function HotelHeroImage({
  src,
  alt,
  sizes,
  quality,
}: {
  src: string | null;
  alt: string;
  sizes: string;
  quality?: number;
}) {
  if (!src) {
    return (
      <div
        aria-hidden="true"
        data-testid="hotel-hero-placeholder"
        className="absolute inset-0 bg-gradient-to-b from-[#8FA3BC] to-[#4B5B73]"
      />
    );
  }
  return (
    <Image
      src={src}
      alt={alt}
      fill
      className="object-cover"
      priority
      quality={quality}
      sizes={sizes}
    />
  );
}
