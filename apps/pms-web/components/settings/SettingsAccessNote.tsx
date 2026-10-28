import { useTranslation } from "@/lib/i18n";

/** Where this role can only look at a section, or can't open it at all (VAY-2154). */
export function SettingsAccessNote({ access }: { access: "view" | "none" }) {
  const { t } = useTranslation();
  return (
    <p
      role="note"
      className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600"
    >
      {t(access === "view" ? "settings.access.viewOnly" : "settings.access.none")}
    </p>
  );
}
