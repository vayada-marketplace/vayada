import type { Metadata } from "next";
import { InviteContent } from "./InviteContent";

// The invitation link carries a one-time token: never send it on as a referrer or index the page.
export const metadata: Metadata = {
  title: "Join your team · vayada PMS",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function InvitePage() {
  return <InviteContent />;
}
