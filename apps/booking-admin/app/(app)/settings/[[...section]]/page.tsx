import { notFound } from "next/navigation";
import { BookDirectBenefitsPage } from "@/components/settings/BookDirectBenefitsPage";
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
  if (!isSettingsPage(page)) notFound();
  return <SettingsSectionPage section={page} />;
}
