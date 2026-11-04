"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import AgencyStayPage from "@/components/agency/AgencyStayPage";
import { useAgencyPage } from "@/contexts/HotelContext";

/**
 * A stay's page on its agency's address (VAY-2461), `/stays/<slug>`. The address's provider
 * shows "not online" for a stay the agency doesn't show, or on a hotel's address.
 */
export default function StayPage() {
  const { agency } = useAgencyPage();
  const { staySlug } = useParams<{ staySlug: string }>();
  const slug = decodeURIComponent(staySlug ?? "");
  const stay = agency?.stays.find((one) => one.slug === slug);
  if (!agency || !stay) return null;
  return (
    <Suspense fallback={<div className="min-h-screen bg-white" />}>
      {/* A new stay starts afresh: its search, rooms and choice are its own. */}
      <AgencyStayPage key={stay.slug} agency={agency} stay={stay} />
    </Suspense>
  );
}
