"use client";

import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { hotelService } from "@/services/api/hotel";

export function AffiliateClickTracker({ slug }: { slug: string }) {
  const referralCode = useSearchParams().get("ref");
  const occurrence = useRef<{ slug: string; referralCode: string; clickId: string } | null>(null);

  useEffect(() => {
    // Only a link with ?ref= is an arrival; nothing keeps the code in a cookie (VAY-2223).
    if (!referralCode) {
      occurrence.current = null;
      return;
    }
    if (occurrence.current?.slug !== slug || occurrence.current.referralCode !== referralCode) {
      occurrence.current = { slug, referralCode, clickId: crypto.randomUUID() };
    }
    // Effect replay retries the same occurrence; A → B → A allocates three IDs.
    void hotelService.recordAffiliateClick(slug, referralCode, occurrence.current.clickId);
  }, [slug, referralCode]);

  return null;
}
