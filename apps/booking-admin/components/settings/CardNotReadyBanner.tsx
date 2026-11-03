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
  | "switch_off"
  /** VAY-2442: vayada Payment chosen, but no bank account to pay the hotel out to yet. */
  | "payout_account_missing";

const REASON_TEXT: Record<CardNotReadyReason, string> = {
  not_connected: "settings.billing.cardNotReadyNotConnected",
  setup_incomplete: "settings.billing.cardNotReadySetupIncomplete",
  account_not_ready: "settings.billing.cardNotReadyAccountNotReady",
  currency: "settings.billing.cardNotReadyCurrency",
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
  // One line, as in Timo's mockup: what's wrong, why, and where to fix it (VAY-2424).
  return (
    <div
      role="status"
      data-testid="card-not-ready-banner"
      className="flex flex-wrap items-center gap-3 rounded-[10px] border border-amber-300 bg-amber-50 px-4 py-3.5 text-sm"
    >
      <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-amber-700" aria-hidden />
      <span className="min-w-0 flex-[1_1_300px] text-amber-900">
        <strong className="font-semibold">{t("settings.billing.cardNotReadyTitle")}</strong>{" "}
        {t(REASON_TEXT[reason])}
      </span>
      {LINK_TEXT[reason] && (
        <a
          href={`#${providerSectionId}`}
          className="font-semibold text-amber-800 underline underline-offset-2 hover:no-underline"
        >
          {t(LINK_TEXT[reason])}
        </a>
      )}
    </div>
  );
}
