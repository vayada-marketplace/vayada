import { redirect } from "next/navigation";

// Booking Flow is gone (VAY-2144): its pages moved to Settings, Add-ons (VAY-2077) and Book Direct
// Benefits (VAY-2072). Old links and bookmarks land on the new page.
const TAB_TARGETS: Record<string, string> = {
  rooms: "/settings/room-filters",
  "guest-form": "/settings/guest-form",
  benefits: "/settings/book-direct-benefits",
  addons: "/add-ons",
};

export default async function BookingFlowRedirect({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { tab } = await searchParams;
  const target =
    typeof tab === "string" && Object.hasOwn(TAB_TARGETS, tab) ? TAB_TARGETS[tab] : null;
  redirect(target ?? "/settings/room-filters");
}
