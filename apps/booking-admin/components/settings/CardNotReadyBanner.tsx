import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";

import { useTranslation } from "@/lib/i18n";

/** Why guests can't pay by card although the hotel offers it (VAY-2424). The page knows the
 * first three itself (no account, an unfinished one, a connected one that still can't take
 * cards); the rest come from the PMS rate screens' card readiness (VAY-2205). */
export type CardNotReadyReason =
  | "not_connected"
  | "setup_incomplete"
  | "account_not_ready"
  | "currency"
  | "not_approved"
  | "switch_off"
  /** VAY-2442: vayada Payment chosen, but no bank account to pay the hotel out to yet. */
  | "payout_account_missing";

const REASON_TEXT: Record<CardNotReadyReason, string> = {
  not_connected: "settings.billing.cardNotReadyNotConnected",
  setup_incomplete: "settings.billing.cardNotReadySetupIncomplete",
  account_not_ready: "settings.billing.cardNotReadyAccountNotReady",
  currency: "settings.billing.cardNotReadyCurrency",
  not_approved: "settings.billing.cardNotReadyNotApproved",
  switch_off: "settings.billing.cardNotReadySwitchOff",
  payout_account_missing: "settings.billing.cardNotReadyPayoutAccount",
};

/** The reasons the hotel fixes in the payment provider section, and the link's words. */
const LINK_TEXT: Partial<Record<CardNotReadyReason, string>> = {
  not_connected: "settings.billing.cardNotReadyLink",
  setup_incomplete: "settings.billing.cardNotReadyFinishLink",
  payout_account_missing: "settings.billing.cardNotReadyPayoutAccountLink",
};

/** Booking Admin › Payments: shown at the top while Credit card is on but guests can't use it. */
export function CardNotReadyBanner({
  reason,
  providerSectionId,
}: {
  reason: CardNotReadyReason;
  /** Where the hotel connects an account, linked when that is what's missing. */
  providerSectionId: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      data-testid="card-not-ready-banner"
      className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3"
    >
      <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
      <div className="min-w-0 text-[13px]">
        <p className="font-semibold text-amber-900">{t("settings.billing.cardNotReadyTitle")}</p>
        <p className="mt-0.5 text-amber-800">{t(REASON_TEXT[reason])}</p>
        {LINK_TEXT[reason] && (
          <a
            href={`#${providerSectionId}`}
            className="mt-1 inline-block font-semibold text-amber-900 underline underline-offset-2 hover:no-underline"
          >
            {t(LINK_TEXT[reason])}
          </a>
        )}
      </div>
    </div>
  );
}
