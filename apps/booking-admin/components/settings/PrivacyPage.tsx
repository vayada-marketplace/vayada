"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowDownTrayIcon,
  CheckCircleIcon,
  DocumentTextIcon,
  EnvelopeIcon,
  ShieldCheckIcon,
  TrashIcon,
  XCircleIcon,
} from "@heroicons/react/24/outline";
import { SettingsCard } from "@vayada/settings-ui";
import { PageHeader, PageLayout } from "@/components/layout/PageLayout";
import { HotelAccountAgreementsCard } from "@/components/settings/HotelAccountAgreementsCard";
import { SettingsBreadcrumb } from "@/components/settings/SettingsSubPage";
import { FeedbackAlert } from "@/components/ui";
import { useTranslation } from "@/lib/i18n";
import {
  identityPrivacyService,
  type ConsentHistoryItem,
  type ConsentStatusResponse,
} from "@/services/api/identityPrivacyClient";

// The privacy page moved from marketplace-web (VAY-2262): consent status, marketing consent, the
// data-rights links and the consent history. The cookie-settings section stayed behind: Booking
// Admin has no cookie banner and sets only strictly necessary cookies.
export function PrivacyPage() {
  const { t, locale } = useTranslation();
  const [consentStatus, setConsentStatus] = useState<ConsentStatusResponse | null>(null);
  const [consentHistory, setConsentHistory] = useState<ConsentHistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUpdating, setIsUpdating] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const formatDate = useCallback(
    (value: string | null) =>
      value
        ? new Date(value).toLocaleDateString(locale, {
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : t("settings.privacy.notSet"),
    [locale, t],
  );

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        setIsLoading(true);
        const [status, history] = await Promise.all([
          identityPrivacyService.getConsentStatus(),
          identityPrivacyService.getConsentHistory(10),
        ]);
        if (disposed) return;
        setConsentStatus(status);
        setConsentHistory(history.history);
      } catch {
        // Keyed, not translated here: `t` changes when the catalog loads and must not re-run this.
        if (!disposed) setErrorKey("settings.privacy.loadFailed");
      } finally {
        if (!disposed) setIsLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  async function toggleMarketingConsent() {
    if (!consentStatus || isUpdating) return;
    try {
      setIsUpdating(true);
      setErrorKey(null);
      setSuccessMessage(null);
      const result = await identityPrivacyService.updateMarketingConsent(
        !consentStatus.marketing_consent,
      );
      setConsentStatus({
        ...consentStatus,
        marketing_consent: result.marketing_consent,
        marketing_consent_at: result.marketing_consent_at,
      });
      setSuccessMessage(result.message);
      const history = await identityPrivacyService.getConsentHistory(10);
      setConsentHistory(history.history);
    } catch {
      setErrorKey("settings.privacy.updateFailed");
    } finally {
      setIsUpdating(false);
    }
  }

  function acceptance(accepted: boolean, acceptedAt: string | null) {
    if (!consentStatus) return t("settings.privacy.unavailable");
    return accepted
      ? t("settings.privacy.acceptedOn", { date: formatDate(acceptedAt) })
      : t("settings.privacy.notAccepted");
  }

  return (
    <PageLayout>
      <div className="max-w-3xl">
        <PageHeader
          breadcrumb={<SettingsBreadcrumb current={t("settings.cards.privacy.title")} />}
          title={t("settings.cards.privacy.title")}
          subtitle={t("settings.privacy.subtitle")}
        />
        <div className="space-y-4">
          {errorKey && <FeedbackAlert type="error" message={t(errorKey)} />}
          {successMessage && <FeedbackAlert type="success" message={successMessage} />}

          {/* VAY-2246: the hotel account's terms and DPA; it loads on its own. */}
          <HotelAccountAgreementsCard />

          {isLoading ? (
            <div className="space-y-4" aria-busy="true">
              {[1, 2].map((item) => (
                <div
                  key={item}
                  className="animate-pulse rounded-lg border border-gray-200 bg-white p-5"
                >
                  <div className="mb-4 h-5 w-1/3 rounded bg-gray-200" />
                  <div className="h-4 w-2/3 rounded bg-gray-200" />
                </div>
              ))}
            </div>
          ) : (
            <>
              <SettingsCard title={t("settings.privacy.consentStatus")} contentClassName="p-0">
                <ul className="divide-y divide-gray-100">
                  <ConsentRow
                    icon={<DocumentTextIcon className="h-5 w-5 text-gray-400" />}
                    title={t("settings.privacy.terms")}
                    description={acceptance(
                      consentStatus?.terms_accepted ?? false,
                      consentStatus?.terms_accepted_at ?? null,
                    )}
                    trailing={<AcceptanceIcon accepted={consentStatus?.terms_accepted} />}
                  />
                  <ConsentRow
                    icon={<ShieldCheckIcon className="h-5 w-5 text-gray-400" />}
                    title={t("settings.privacy.privacyPolicy")}
                    description={acceptance(
                      consentStatus?.privacy_accepted ?? false,
                      consentStatus?.privacy_accepted_at ?? null,
                    )}
                    trailing={<AcceptanceIcon accepted={consentStatus?.privacy_accepted} />}
                  />
                  <ConsentRow
                    icon={<EnvelopeIcon className="h-5 w-5 text-gray-400" />}
                    title={t("settings.privacy.marketing")}
                    description={t("settings.privacy.marketingDescription")}
                    trailing={
                      consentStatus ? (
                        <button
                          type="button"
                          role="switch"
                          aria-label={t("settings.privacy.marketing")}
                          aria-checked={consentStatus.marketing_consent}
                          onClick={() => void toggleMarketingConsent()}
                          disabled={isUpdating}
                          className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 ${
                            consentStatus.marketing_consent ? "bg-primary-600" : "bg-gray-200"
                          } ${isUpdating ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                        >
                          <span
                            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                              consentStatus.marketing_consent ? "translate-x-5" : "translate-x-0"
                            }`}
                          />
                        </button>
                      ) : (
                        <span className="text-[13px] text-gray-500">
                          {t("settings.privacy.unavailable")}
                        </span>
                      )
                    }
                  />
                </ul>
              </SettingsCard>

              <SettingsCard
                title={t("settings.privacy.dataRights")}
                description={t("settings.privacy.dataRightsDescription")}
                contentClassName="p-0"
              >
                <ul className="divide-y divide-gray-100">
                  <li>
                    <Link
                      href="/settings/data-export"
                      className="flex items-center justify-between gap-4 px-4 py-4 transition-colors hover:bg-gray-50 md:px-5"
                    >
                      <span className="flex items-center gap-4">
                        <ArrowDownTrayIcon className="h-5 w-5 text-gray-400" />
                        <span>
                          <span className="block text-[14px] font-medium text-gray-900">
                            {t("settings.privacy.exportTitle")}
                          </span>
                          <span className="block text-[13px] text-gray-500">
                            {t("settings.privacy.exportDescription")}
                          </span>
                        </span>
                      </span>
                      <span className="text-gray-400" aria-hidden="true">
                        →
                      </span>
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/settings/delete-account"
                      className="flex items-center justify-between gap-4 px-4 py-4 transition-colors hover:bg-gray-50 md:px-5"
                    >
                      <span className="flex items-center gap-4">
                        <TrashIcon className="h-5 w-5 text-red-400" />
                        <span>
                          <span className="block text-[14px] font-medium text-gray-900">
                            {t("settings.privacy.deleteTitle")}
                          </span>
                          <span className="block text-[13px] text-gray-500">
                            {t("settings.privacy.deleteDescription")}
                          </span>
                        </span>
                      </span>
                      <span className="text-gray-400" aria-hidden="true">
                        →
                      </span>
                    </Link>
                  </li>
                </ul>
              </SettingsCard>

              {consentHistory.length > 0 && (
                <SettingsCard title={t("settings.privacy.history")} contentClassName="p-0">
                  <ul className="divide-y divide-gray-100">
                    {consentHistory.slice(0, 5).map((item) => (
                      <li
                        key={item.id}
                        className="flex items-center justify-between gap-4 px-4 py-3 md:px-5"
                      >
                        <span>
                          <span className="block text-[14px] font-medium capitalize text-gray-900">
                            {item.consent_type.replace("_", " ")}
                          </span>
                          <span className="block text-[12px] text-gray-500">
                            {formatDate(item.created_at)}
                          </span>
                        </span>
                        <span
                          className={`rounded px-2 py-1 text-[12px] font-medium ${
                            item.consent_given
                              ? "bg-green-100 text-green-800"
                              : "bg-red-100 text-red-800"
                          }`}
                        >
                          {item.consent_given
                            ? t("settings.privacy.given")
                            : t("settings.privacy.withdrawn")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </SettingsCard>
              )}
            </>
          )}
        </div>
      </div>
    </PageLayout>
  );
}

function ConsentRow({
  icon,
  title,
  description,
  trailing,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  trailing: React.ReactNode;
}) {
  return (
    <li className="flex items-center justify-between gap-4 px-4 py-4 md:px-5">
      <span className="flex items-center gap-4">
        {icon}
        <span>
          <span className="block text-[14px] font-medium text-gray-900">{title}</span>
          <span className="block text-[13px] text-gray-500">{description}</span>
        </span>
      </span>
      {trailing}
    </li>
  );
}

function AcceptanceIcon({ accepted }: { accepted: boolean | undefined }) {
  if (accepted === undefined) return null;
  return accepted ? (
    <CheckCircleIcon className="h-5 w-5 text-green-500" aria-hidden="true" />
  ) : (
    <XCircleIcon className="h-5 w-5 text-red-500" aria-hidden="true" />
  );
}
