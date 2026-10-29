"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SettingsCardGrid } from "@vayada/settings-ui";
import { PageHeader } from "@/components/layout/PageHeader";
import { useTranslation } from "@/lib/i18n";
import { getPmsSettingsCards, legacySettingsAnchorTarget } from "@/lib/settings/navigation";
import { usePmsAccess } from "@/lib/settings/PmsAccessContext";

// /settings is the card grid, the same as Booking Admin's; each card opens its own page (VAY-2275).
export default function SettingsPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const access = usePmsAccess();
  const [legacyChecked, setLegacyChecked] = useState(false);

  useEffect(() => {
    const target = legacySettingsAnchorTarget(window.location.hash);
    if (target) router.replace(target);
    else setLegacyChecked(true);
  }, [router]);

  if (!legacyChecked) return null;

  const { featured, cards } = getPmsSettingsCards(t, access);
  return (
    <div className="p-4 md:p-6">
      <div className="max-w-6xl">
        <PageHeader title={t("settings.title")} className="mb-4 md:mb-5" />
        <SettingsCardGrid
          featured={featured}
          cards={cards}
          openLabel={t("settings.index.open")}
          comingSoonLabel={t("settings.index.comingSoon")}
        />
      </div>
    </div>
  );
}
