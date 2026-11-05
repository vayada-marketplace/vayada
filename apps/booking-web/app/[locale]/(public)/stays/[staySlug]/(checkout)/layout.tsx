import type { Metadata } from "next";

import AgencyStayScope from "@/components/agency/AgencyStayScope";

// VAY-2462: a stay's checkout and bookings on its agency's address, never indexed (VAY-664).
export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function AgencyStayCheckoutLayout({ children }: { children: React.ReactNode }) {
  return <AgencyStayScope>{children}</AgencyStayScope>;
}
