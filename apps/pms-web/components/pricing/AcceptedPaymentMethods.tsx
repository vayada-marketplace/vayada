"use client";

import { type ComponentProps } from "react";
import { AcceptedPaymentMethods as SharedAcceptedPaymentMethods } from "@vayada/product-onboarding/AcceptedPaymentMethods";
import { useTranslation } from "@/lib/i18n";

export type { PaymentMethod } from "@vayada/product-onboarding/AcceptedPaymentMethods";

export function AcceptedPaymentMethods(
  props: Omit<ComponentProps<typeof SharedAcceptedPaymentMethods>, "t">,
) {
  const { t } = useTranslation();
  return <SharedAcceptedPaymentMethods {...props} t={t} />;
}
