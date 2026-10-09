"use client";

import {
  FirstPricingSetup as SharedFirstPricingSetup,
  type FirstPricingSetupProps,
} from "@vayada/product-onboarding/FirstPricingSetup";
import { useTranslation } from "@/lib/i18n";

export { firstPricingInput, type SetupRoom } from "@vayada/product-onboarding/FirstPricingSetup";

export function FirstPricingSetup(props: Omit<FirstPricingSetupProps, "t">) {
  const { t } = useTranslation();
  return <SharedFirstPricingSetup {...props} t={t} />;
}
