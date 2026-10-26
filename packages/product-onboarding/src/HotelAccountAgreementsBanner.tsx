"use client";

import { useEffect, useState } from "react";
import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  DocumentCheckIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import type { HotelAccountAgreementsStatus } from "@vayada/domain-hotels";

import { fillTemplate } from "./fillTemplate";
import type { HotelAccountAgreementsClient } from "./hotelAccountAgreementsApi";

const MARKETING_BASE_URL = process.env.NEXT_PUBLIC_MARKETING_URL || "https://vayada.com";

/** VAY-2246: the banner's words. English by default; Booking Admin and the PMS pass their catalogs. */
export type HotelAccountAgreementsMessages = {
  title: string;
  /** {account}: the hotel account's name; {terms}: the hotel terms link. */
  body: string;
  /** Stands in for {account} when the session has no name for it. */
  yourAccount: string;
  hotelTerms: string;
  /** {date}: the DPA's version date. */
  meta: string;
  read: string;
  accept: string;
  accepting: string;
  failed: string;
  /** {account} */
  accepted: string;
  /** {link}: where the acceptance is shown later. Empty where there is no such page. */
  acceptedWhere: string;
  acceptedWhereLink: string;
  dismiss: string;
};

export const HOTEL_ACCOUNT_AGREEMENTS_MESSAGES: HotelAccountAgreementsMessages = {
  title: "Accept the data processing agreement",
  body: "vayada stores your guests’ booking data on your behalf, and the GDPR (Art. 28) requires a written agreement for that. As account admin, you accept it for {account}, together with the {terms} it belongs to.",
  yourAccount: "your hotel account",
  hotelTerms: "hotel terms",
  meta: "Version of {date} · Only the account admin sees this.",
  read: "Read the agreement",
  accept: "Accept",
  accepting: "Accepting…",
  failed: "That didn’t work. Please try again.",
  accepted: "Data processing agreement accepted for {account}.",
  acceptedWhere: "",
  acceptedWhereLink: "",
  dismiss: "Close",
};

/** A version date ("2026-10-24") in the reader's language: "24 October 2026". */
export function formatAgreementVersion(version: string, locale = "en"): string {
  const date = new Date(`${version}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return version;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

type Props = {
  client: Pick<HotelAccountAgreementsClient, "load" | "accept">;
  messages?: HotelAccountAgreementsMessages;
  locale?: string;
  /** Booking Admin's Settings › Privacy & data, linked from the confirmation; unset in the PMS. */
  acceptedHref?: string;
  /** Not on pages that show the same Accept themselves (Booking Admin's Privacy & data). */
  hidden?: boolean;
  /** Lines the banner up with the app's page content (padding, width). */
  frameClassName?: string;
  termsUrl?: string;
  dpaUrl?: string;
};

/**
 * VAY-2246: until the hotel account accepts the current hotel terms and data processing agreement, its
 * account admin sees this on every page (Paper: VAY-2246 DPA acceptance, row 3). Nobody else does, and
 * nothing is blocked. After "Accept" a confirmation shows once.
 */
export default function HotelAccountAgreementsBanner({
  client,
  messages = HOTEL_ACCOUNT_AGREEMENTS_MESSAGES,
  locale = "en",
  acceptedHref,
  hidden = false,
  frameClassName = "px-4 pt-4 md:px-6 md:pt-6",
  termsUrl = `${MARKETING_BASE_URL}/terms`,
  dpaUrl = `${MARKETING_BASE_URL}/terms/dpa`,
}: Props) {
  const [status, setStatus] = useState<HotelAccountAgreementsStatus | null>(null);
  const [phase, setPhase] = useState<"idle" | "accepting" | "failed" | "accepted" | "closed">(
    "idle",
  );

  useEffect(() => {
    const controller = new AbortController();
    client
      .load({ signal: controller.signal })
      .then(setStatus)
      // Unknown means no banner: the next page load asks again.
      .catch(() => undefined);
    return () => controller.abort();
  }, [client]);

  if (!status || phase === "closed") return null;
  const account = status.accountName?.trim() ? (
    <strong className="font-semibold text-gray-900">{status.accountName}</strong>
  ) : (
    messages.yourAccount
  );

  if (phase === "accepted") {
    return (
      <div className={frameClassName}>
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-xl border border-green-200 bg-green-50 px-4 py-3"
        >
          <CheckCircleIcon className="mt-px h-5 w-5 shrink-0 text-green-600" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-sm text-green-800">
            {fillTemplate(messages.accepted, {
              account: status.accountName || messages.yourAccount,
            })}
            {acceptedHref && messages.acceptedWhere ? (
              <>
                {" "}
                {fillTemplate(messages.acceptedWhere, {
                  link: (
                    <a
                      href={acceptedHref}
                      className="font-semibold underline-offset-2 hover:underline"
                    >
                      {messages.acceptedWhereLink}
                    </a>
                  ),
                })}
              </>
            ) : null}
          </p>
          <button
            type="button"
            onClick={() => setPhase("closed")}
            aria-label={messages.dismiss}
            className="shrink-0 rounded text-green-700 hover:text-green-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-600"
          >
            <XMarkIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  if (hidden || status.accepted || !status.canAccept) return null;

  async function accept() {
    if (!status) return;
    setPhase("accepting");
    try {
      const next = await client.accept(status.current);
      setStatus(next);
      setPhase(next.accepted ? "accepted" : "failed");
    } catch {
      setPhase("failed");
    }
  }

  const busy = phase === "accepting";
  return (
    <div className={frameClassName}>
      <section
        aria-labelledby="hotel-account-agreements-title"
        className="flex flex-col gap-3.5 rounded-xl border border-primary-200 bg-primary-50 p-4 md:flex-row md:items-center md:gap-4 md:px-5"
      >
        <div className="flex min-w-0 flex-1 items-start gap-3 md:items-center md:gap-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary-100 bg-white">
            <DocumentCheckIcon className="h-5 w-5 text-primary-600" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="hotel-account-agreements-title" className="text-sm font-semibold text-gray-900">
              {messages.title}
            </h2>
            <p className="mt-1 text-[13px] leading-5 text-gray-700">
              {fillTemplate(messages.body, {
                account,
                terms: (
                  <a
                    href={termsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-primary-600 hover:text-primary-700"
                  >
                    {messages.hotelTerms}
                  </a>
                ),
              })}
            </p>
            <p className="mt-1 text-xs text-gray-500">
              {fillTemplate(messages.meta, {
                date: formatAgreementVersion(status.current.dpaVersion, locale),
              })}
            </p>
            {phase === "failed" && (
              <p role="alert" className="mt-1 text-[13px] text-red-700">
                {messages.failed}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2 md:flex-row">
          <a
            href={dpaUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 md:h-9"
          >
            {messages.read}
            <ArrowTopRightOnSquareIcon className="h-4 w-4" aria-hidden="true" />
          </a>
          <button
            type="button"
            onClick={() => void accept()}
            disabled={busy}
            className="inline-flex h-10 items-center justify-center rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60 md:h-9"
          >
            {busy ? messages.accepting : messages.accept}
          </button>
        </div>
      </section>
    </div>
  );
}
