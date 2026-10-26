import type { Metadata } from "next";
import AroundPageClient from "./AroundPageClient";

// Like the booking's own page, never indexed (VAY-664).
export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function AroundPage({ params }: { params: Promise<{ reference: string }> }) {
  const { reference } = await params;
  return <AroundPageClient reference={reference} />;
}
