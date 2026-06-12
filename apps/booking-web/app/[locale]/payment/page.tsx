import type { Metadata } from "next";
import PaymentPageClient from "./PaymentPageClient";

/**
 * VAY-664: The payment step must never be indexed.
 * Enforced at the framework level here so it applies regardless of
 * whether the client component renders a meta tag.
 */
export const metadata: Metadata = {
  title: "Payment | Book Your Stay",
  description: "Complete payment for your stay.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function PaymentPage() {
  return <PaymentPageClient />;
}
