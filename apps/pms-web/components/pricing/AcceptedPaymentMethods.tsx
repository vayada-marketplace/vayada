"use client";

import { type ComponentProps } from "react";
import { AcceptedPaymentMethods as SharedAcceptedPaymentMethods } from "@vayada/product-onboarding/AcceptedPaymentMethods";
import { useTranslation } from "@/lib/i18n";
import { usePricingManualMethods } from "./pricingManualMethods";
import * as ui from "./pricingStyles";

export type { PaymentMethod } from "@vayada/product-onboarding/AcceptedPaymentMethods";

export function AcceptedPaymentMethods(
  props: Omit<ComponentProps<typeof SharedAcceptedPaymentMethods>, "t">,
) {
  const { t } = useTranslation();
  const manualMethods = usePricingManualMethods();
  return (
    <SharedAcceptedPaymentMethods
      manualMethods={manualMethods}
      {...props}
      t={t}
      look={ui.formLook}
    />
  );
}
