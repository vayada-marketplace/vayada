"use client";

import {
  FirstPricingSetup as SharedFirstPricingSetup,
  type FirstPricingSetupProps,
} from "@vayada/product-onboarding/FirstPricingSetup";
import { useTranslation } from "@/lib/i18n";
import { usePricingManualMethods } from "./pricingManualMethods";
import * as ui from "./pricingStyles";

export { firstPricingInput, type SetupRoom } from "@vayada/product-onboarding/FirstPricingSetup";

export function FirstPricingSetup(props: Omit<FirstPricingSetupProps, "t">) {
  const { t } = useTranslation();
  const manualMethods = usePricingManualMethods();
  return (
    <SharedFirstPricingSetup manualMethods={manualMethods} {...props} t={t} look={ui.formLook} />
  );
}
