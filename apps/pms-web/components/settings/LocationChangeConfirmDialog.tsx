"use client";

import type { ComponentProps } from "react";
import {
  LocationChangeConfirmDialog as SharedLocationChangeConfirmDialog,
  type LocationChangeConfirmTranslate,
} from "@vayada/product-onboarding/LocationChangeConfirmDialog";
import { useTranslation } from "@/lib/i18n";

export { locationChangeToConfirm } from "@vayada/product-onboarding/LocationChangeConfirmDialog";

/**
 * VAY-2582: the live hotel's time zone / country question, with the PMS's copy. The question itself is
 * shared with Booking Admin › Settings › Location (VAY-2586); the PMS keeps its keys under
 * `settings.property.locationConfirm.*`.
 */
export function LocationChangeConfirmDialog(
  props: Omit<ComponentProps<typeof SharedLocationChangeConfirmDialog>, "translate" | "locale">,
) {
  const { t, locale } = useTranslation();
  const translate: LocationChangeConfirmTranslate = (key, params) =>
    key === "locationConfirm.saving" ? t("common.saving") : t(`settings.property.${key}`, params);
  return <SharedLocationChangeConfirmDialog {...props} translate={translate} locale={locale} />;
}
