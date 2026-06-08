import type { Metadata } from "next";
import AddonsPageClient from "./AddonsPageClient";

/**
 * VAY-664: The addons selection page must never be indexed.
 * Enforced at the framework level here so it applies regardless of
 * whether the client component renders a meta tag.
 */
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default function AddonsPage() {
  return <AddonsPageClient />;
}
