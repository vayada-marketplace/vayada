import { getImageProps, type ImageProps, type StaticImageData } from "next/image";
import { preload as preloadImage } from "react-dom";

import { photoFileUrl } from "./photo-files.mjs";

type PhotoProps = Omit<ImageProps, "src" | "loader" | "priority"> & { src: StaticImageData };

/**
 * next/image's `<img>` (same widths, `sizes` and lazy loading) inside a `<picture>` that offers
 * AVIF, then WebP, then the photo's own format: what Next's image server picked for each browser,
 * as files made at build time, so the site is plain static files. Use it instead of `<Image>`,
 * which has no loader here and fails the build.
 */
export function Photo({ preload = false, ...props }: PhotoProps) {
  // `next dev` has no converted files (the export script makes them): show the originals.
  if (process.env.NODE_ENV === "development") {
    const { props: original } = getImageProps({ ...props, preload, unoptimized: true });
    return (
      <picture>
        <img {...original} alt={props.alt} />
      </picture>
    );
  }
  const variant = (format: "avif" | "webp" | "original") =>
    getImageProps({ ...props, preload, loader: (photo) => photoFileUrl(photo, format) }).props;
  const img = variant("original");
  const avif = variant("avif").srcSet;
  // <Image preload> preloaded its srcset; the AVIF one is the file a browser that can show it takes.
  if (preload) {
    preloadImage(img.src, {
      as: "image",
      type: "image/avif",
      imageSrcSet: avif,
      imageSizes: img.sizes,
    });
  }
  return (
    <picture>
      <source type="image/avif" srcSet={avif} sizes={img.sizes} />
      <source type="image/webp" srcSet={variant("webp").srcSet} sizes={img.sizes} />
      <img {...img} alt={props.alt} />
    </picture>
  );
}
