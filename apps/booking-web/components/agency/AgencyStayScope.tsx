"use client";

import type { ReactNode } from "react";
import { useParams } from "next/navigation";
import AnalyticsConsent from "@/components/AnalyticsConsent";
import { StayHotelProvider, useAgencyPage } from "@/contexts/HotelContext";

/**
 * VAY-2462: today's checkout and booking pages for one stay of an agency's page, on the agency's
 * address (`/stays/<slug>/book`, `/stays/<slug>/booking/<reference>` …): the stay's own hotel,
 * add-ons, payment and policies, in the agency's look (its bar, colours and fonts). The address's
 * provider has already said "not online" for a stay the agency doesn't show.
 */
export default function AgencyStayScope({ children }: { children: ReactNode }) {
  const { agency } = useAgencyPage();
  const { staySlug } = useParams<{ staySlug: string }>();
  let slug = "";
  try {
    slug = decodeURIComponent(staySlug ?? "");
  } catch {}
  const stay = agency?.stays.find((one) => one.slug === slug);
  if (!agency || !stay) return null;
  return (
    <StayHotelProvider key={stay.slug} slug={stay.slug}>
      {children}
      {/* This stay's events are recorded with its own choice. */}
      <AnalyticsConsent />
    </StayHotelProvider>
  );
}
