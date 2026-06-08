import type { Metadata } from "next";
import MyBookingPageClient from "./MyBookingPageClient";

/**
 * VAY-664: The guest private booking dashboard must never be indexed.
 * Enforced at the framework level here so it applies regardless of
 * whether the client component renders a meta tag.
 */
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default function MyBookingPage() {
  return <MyBookingPageClient />;
}
