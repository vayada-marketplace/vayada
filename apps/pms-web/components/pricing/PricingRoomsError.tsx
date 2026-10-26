"use client";

import { PricingError } from "@vayada/product-onboarding/pricingSetupAmounts";
import { useTranslation } from "@/lib/i18n";
import { ApiErrorResponse } from "@/services/api/client";
import { PmsPropertySelectionRequiredError } from "@/services/api/pmsPropertyClient";

import { errorText } from "./pricingAmounts";
import * as ui from "./pricingStyles";

/** The Prices tab could not read the property's rooms. A cause the app explains (no property selected, rooms of
 * another property) keeps its text; no access says so; anything else, such as a server error, gets a plain message
 * instead of the server's, and Retry reads the rooms again. */
export function PricingRoomsError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useTranslation();
  const forbidden = error instanceof ApiErrorResponse && error.status === 403;
  const explained =
    error instanceof PricingError || error instanceof PmsPropertySelectionRequiredError;
  return (
    <div role="alert" className={ui.errorBanner}>
      <p>
        {forbidden
          ? t("pricing.page.roomsForbidden")
          : explained
            ? errorText(error, t, "pricing.page.loadFailed")
            : t("pricing.page.roomsFailed")}
      </p>
      {!forbidden && (
        <button type="button" onClick={onRetry} className="mt-2 font-semibold underline">
          {t("common.retry")}
        </button>
      )}
    </div>
  );
}
