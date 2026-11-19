"use client";

import { Suspense } from "react";
import { PartnerAuthorizePage } from "@/components/partner/PartnerAuthorizePage";

// VAY-2436: where a partner app sends a hotel to connect it once (/partner/oauth/authorize?...).
export default function PartnerAuthorizeRoute() {
  return (
    <Suspense fallback={null}>
      <PartnerAuthorizePage />
    </Suspense>
  );
}
