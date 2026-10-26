import type { ComponentType, SVGProps } from "react";
import {
  CakeIcon,
  CameraIcon,
  HeartIcon,
  MapIcon,
  MusicalNoteIcon,
  ShoppingBagIcon,
  StarIcon,
  SunIcon,
} from "@heroicons/react/24/outline";
import type { NearbyCategoryIcon, NearbyCategoryView } from "@vayada/domain-hotels";
import { NEARBY_CATEGORY_HEX } from "./nearbyPlaces";

export const nearbyCategoryIcons: Record<
  NearbyCategoryIcon,
  ComponentType<SVGProps<SVGSVGElement>>
> = {
  "musical-note": MusicalNoteIcon,
  cake: CakeIcon,
  sun: SunIcon,
  camera: CameraIcon,
  map: MapIcon,
  heart: HeartIcon,
  star: StarIcon,
  "shopping-bag": ShoppingBagIcon,
};

/** A category's round badge: its icon in white on its colour, as the list and the map draw it. */
export function NearbyCategoryBadge({
  category,
  size = 28,
  className = "",
}: {
  category: Pick<NearbyCategoryView, "color" | "icon">;
  size?: number;
  className?: string;
}) {
  const Icon = nearbyCategoryIcons[category.icon];
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full text-white ${className}`}
      style={{ width: size, height: size, backgroundColor: NEARBY_CATEGORY_HEX[category.color] }}
    >
      <Icon
        className="shrink-0"
        style={{ width: size * 0.55, height: size * 0.55 }}
        strokeWidth={2}
      />
    </span>
  );
}
