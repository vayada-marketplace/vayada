"use client";

import { useEffect, useState } from "react";
import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  DocumentTextIcon,
} from "@heroicons/react/24/outline";
import type { HotelAccountAgreementsStatus } from "@vayada/domain-hotels";
import { formatAgreementVersion } from "@vayada/product-onboarding/HotelAccountAgreementsBanner";
import { SettingsCard } from "@vayada/settings-ui";
import { useTranslation } from "@/lib/i18n";
import { hotelAccountAgreementsApi } from "@/services/api/hotelAccountAgreementsClient";

const MARKETING_BASE_URL = process.env.NEXT_PUBLIC_MARKETING_URL || "https://vayada.com";

/**
 * VAY-2246: Settings › Privacy & data shows the hotel account's contract with vayada (the hotel terms and
 * the data processing agreement): which versions it accepted, when and by whom. While they still need
 * accepting, the account admin accepts here (the banner stays off this page); others are told who can.
 */
export function HotelAccountAgreementsCard() {
  const { t, locale } = useTranslation();
  const [status, setStatus] = useState<HotelAccountAgreementsStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [acceptFailed, setAcceptFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    hotelAccountAgreementsApi
      .load({ signal: controller.signal })
      .then(setStatus)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);

  if (failed) {
    return (
      <SettingsCard title={t("settings.privacy.agreements.titleUnnamed")}>
        <p className="text-[13px] text-gray-500">{t("settings.privacy.agreements.loadFailed")}</p>
      </SettingsCard>
    );
  }
  if (!status) return null;

  async function accept() {
    if (!status) return;
    setAccepting(true);
    setAcceptFailed(false);
    try {
      setStatus(await hotelAccountAgreementsApi.accept(status.current));
    } catch {
      setAcceptFailed(true);
    } finally {
      setAccepting(false);
    }
  }

  const accepted = status.accepted;
  const acceptedLine = accepted
    ? t("settings.privacy.agreements.acceptedBy", {
        date: new Date(accepted.acceptedAt).toLocaleDateString(locale, {
          day: "numeric",
          month: "short",
          year: "numeric",
        }),
        name: accepted.acceptedBy.name?.trim() || accepted.acceptedBy.email,
      })
    : t("settings.privacy.agreements.notAccepted");
  const rows = [
    {
      key: "terms",
      title: t("settings.privacy.agreements.terms"),
      version: status.current.termsVersion,
      href: `${MARKETING_BASE_URL}/terms`,
    },
    {
      key: "dpa",
      title: t("settings.privacy.agreements.dpa"),
      version: status.current.dpaVersion,
      href: `${MARKETING_BASE_URL}/terms/dpa`,
    },
  ];
  const account = status.accountName?.trim();

  return (
    <SettingsCard
      title={
        account
          ? t("settings.privacy.agreements.title", { account })
          : t("settings.privacy.agreements.titleUnnamed")
      }
      description={t("settings.privacy.agreements.description")}
      contentClassName="p-0"
      footer={
        accepted ? undefined : status.canAccept ? (
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="text-[13px] text-gray-600">
              <p>
                {account
                  ? t("settings.privacy.agreements.adminCanAccept", { account })
                  : t("settings.privacy.agreements.adminCanAcceptUnnamed")}
              </p>
              {acceptFailed && (
                <p role="alert" className="mt-1 text-red-700">
                  {t("agreements.banner.failed")}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => void accept()}
              disabled={accepting}
              className="inline-flex h-10 shrink-0 items-center justify-center rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60 md:h-9"
            >
              {accepting ? t("agreements.banner.accepting") : t("agreements.banner.accept")}
            </button>
          </div>
        ) : (
          <p className="text-[13px] text-gray-600">{t("settings.privacy.agreements.askAdmin")}</p>
        )
      }
    >
      <ul className="divide-y divide-gray-100">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-4 px-4 py-4 md:px-5">
            <DocumentTextIcon className="h-5 w-5 shrink-0 text-gray-400" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium text-gray-900">{row.title}</span>
              <span className="block text-[13px] text-gray-500">
                {t("settings.privacy.agreements.version", {
                  date: formatAgreementVersion(row.version, locale),
                })}
              </span>
              <span className={`block text-[13px] ${accepted ? "text-gray-500" : "text-red-700"}`}>
                {acceptedLine}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-3">
              <a
                href={row.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[13px] font-medium text-primary-600 hover:text-primary-700"
              >
                {t("settings.privacy.agreements.read")}
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
              {accepted && (
                <CheckCircleIcon className="h-5 w-5 text-green-500" aria-hidden="true" />
              )}
            </span>
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}
