"use client";

import { type ComponentProps } from "react";
import { IncludedPricing as SharedIncludedPricing } from "@vayada/product-onboarding/IncludedPricing";
import { useTranslation } from "@/lib/i18n";
import * as ui from "./pricingStyles";

export {
  includedInput,
  includedPrice,
  type IncludedInput,
} from "@vayada/product-onboarding/IncludedPricing";

export function IncludedPricing(props: Omit<ComponentProps<typeof SharedIncludedPricing>, "t">) {
  const { t } = useTranslation();
  return <SharedIncludedPricing {...props} t={t} look={ui.formLook} />;
}
