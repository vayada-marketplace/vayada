import Image from "next/image";
import type { ReactNode } from "react";

import type { SiteImage } from "@/sites/types";

/** A photo beside its text; `flipped` puts the photo on the right. On a phone they stack, photo
 * first. */
export function Split({
  id,
  image,
  flipped = false,
  children,
}: {
  id?: string;
  image: SiteImage;
  flipped?: boolean;
  children: ReactNode;
}) {
  return (
    <div id={id} className={flipped ? "split split-flipped" : "split"}>
      <Image src={image.src} alt={image.alt} sizes="(max-width: 900px) 100vw, 640px" />
      <div className="split-text">{children}</div>
    </div>
  );
}
