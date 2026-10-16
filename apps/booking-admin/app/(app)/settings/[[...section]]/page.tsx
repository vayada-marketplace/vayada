import { notFound } from "next/navigation";
import { BookDirectBenefitsPage } from "@/components/settings/BookDirectBenefitsPage";
import { GuestFormPage } from "@/components/settings/GuestFormPage";
import { RoomFiltersPage } from "@/components/settings/RoomFiltersPage";
import { SettingsIndex } from "@/components/settings/SettingsIndex";
import SettingsSectionPage from "@/components/settings/SettingsSectionPage";
import { isSettingsPage } from "@/lib/utils/settingsSectionUrl";

// /settings is the card grid; /settings/<page> opens one card (VAY-2072).
export default async function SettingsRoute({
  params,
}: {
  params: Promise<{ section?: string[] }>;
}) {
  const { section } = await params;
  if (!section) return <SettingsIndex />;
  const [page, ...rest] = section;
  if (rest.length > 0) notFound();
  if (page === "book-direct-benefits") return <BookDirectBenefitsPage />;
  if (page === "room-filters") return <RoomFiltersPage />;
  if (page === "guest-form") return <GuestFormPage />;
  if (!isSettingsPage(page)) notFound();
  return <SettingsSectionPage section={page} />;
}
