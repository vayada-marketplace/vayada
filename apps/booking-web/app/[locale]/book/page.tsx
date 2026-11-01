import type { Metadata } from "next";
import BookPageClient from "./BookPageClient";

/**
 * VAY-664: The booking checkout page must never be indexed.
 * Enforced at the framework level here so it applies regardless of
 * whether the client component renders a meta tag.
 */
export const metadata: Metadata = {
  title: "Book Your Stay",
  description: "Your extras, details and payment for the rooms you chose.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function BookPage() {
  return <BookPageClient />;
}
