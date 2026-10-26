import type { SVGProps } from "react";

/** A bed, the icon for room types (Paper rev 2 decision: a bed for rooms, HotelIcon for the hotel). */
export function QuickBedIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 18.5V6.75M21 18.5v-4.75a2.25 2.25 0 0 0-2.25-2.25H3M3 16h18"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6.75 11.5V10a1.5 1.5 0 0 1 1.5-1.5h2.5a1.5 1.5 0 0 1 1.5 1.5v1.5"
      />
    </svg>
  );
}
