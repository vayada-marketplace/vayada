"use client";

import { useId, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type {
  PublicBookingQuote,
  PublicQuoteGuestDisclosure,
} from "@vayada/domain-booking/replacement-pricing";
import { policyBlocks } from "@/lib/cancellationPolicy";
import CancellationPolicy, { chevron } from "./CancellationPolicy";
import ConsentTile from "./ConsentTile";

type Choices = PublicQuoteGuestDisclosure["choices"];
const card = "bg-white rounded-2xl border border-gray-200 p-5 md:p-8";

/** A closed-by-default part of "Before you book". A `scroll` part keeps long text in a box that
 * scrolls, and can be focused to scroll it from the keyboard. */
function Section({
  title,
  scroll = false,
  children,
}: {
  title: string;
  scroll?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="border-t border-gray-100 pt-4">
      <h3>
        <button
          type="button"
          className="flex w-full items-center gap-3 text-left text-[17px] font-semibold text-gray-900"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="flex-1">{title}</span>
          {chevron(open)}
        </button>
      </h3>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label={title}
          tabIndex={scroll ? 0 : undefined}
          className={`mt-3 ${scroll ? "max-h-72 overflow-y-auto" : ""}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** The hotel's guest rules as sentences, in the page's language. */
function ruleSentences(r: Choices, t: ReturnType<typeof useTranslations>): string[] {
  return [
    r.checkInUntil === "00:00"
      ? t("rules.checkInToMidnight", { from: r.checkInTime })
      : r.checkInUntil
        ? t("rules.checkInBetween", { from: r.checkInTime, until: r.checkInUntil })
        : t("rules.checkIn", { time: r.checkInTime }),
    r.checkOutFrom
      ? t("rules.checkOutFrom", { from: r.checkOutFrom, time: r.checkOutTime })
      : t("rules.checkOut", { time: r.checkOutTime }),
    [
      t(r.childrenEnabled ? "rules.childrenWelcome" : "rules.childrenNo"),
      r.adultAgeThreshold !== null ? t("rules.adultsFrom", { age: r.adultAgeThreshold }) : "",
    ]
      .filter(Boolean)
      .join(" "),
    t(r.phoneRequired ? "rules.phoneRequired" : "rules.phoneOptional"),
    t(r.arrivalTimeEnabled ? "rules.arrivalYes" : "rules.arrivalNo"),
    t(r.specialRequestsEnabled ? "rules.requestsYes" : "rules.requestsNo"),
  ];
}

/** Step 3's "Before you book" (VAY-2347): quick facts, the times line, the cancellation policy
 * (open; one block per policy), the guest rules and the hotel's terms (closed), then the one tick
 * that agrees to all of them. */
export default function BeforeYouBook({
  quote,
  disclosure,
  rulesFailed,
  onRetryRules,
  roomNames,
  today,
  hotelCountry,
  termsText,
  formatMoney,
  agreed,
  consentDisabled,
  consentErrorId,
  onAgree,
  status,
}: {
  quote: PublicBookingQuote;
  /** This price's guest rules; null while they load or when they failed. */
  disclosure: PublicQuoteGuestDisclosure | null;
  rulesFailed: boolean;
  onRetryRules: () => void;
  roomNames: Readonly<Record<string, string>>;
  /** The hotel's date today (YYYY-MM-DD). */
  today: string;
  hotelCountry: string | null;
  termsText: string | null;
  formatMoney: (minor: string) => string;
  agreed: boolean;
  consentDisabled: boolean;
  /** Confirm was pressed before ticking (VAY-2306): the id of the message that says so. */
  consentErrorId?: string;
  onAgree: (checked: boolean) => void;
  /** Why the tick can't be given yet (an expired price, rooms without their names). */
  status?: ReactNode;
}) {
  const t = useTranslations("beforeYouBook");
  const tHome = useTranslations("home");
  const rules = disclosure?.choices ?? null;
  const blocks = policyBlocks(quote, { today, roomNames });
  const meals = Array.from(new Set(quote.rooms.map((room) => room.mealPlan)));
  const facts: [string, string][] = rules
    ? [
        [
          t("checkIn"),
          rules.checkInUntil === "00:00"
            ? t("checkInToMidnight", { from: rules.checkInTime })
            : rules.checkInUntil
              ? t("checkInBetween", { from: rules.checkInTime, until: rules.checkInUntil })
              : t("checkInFrom", { time: rules.checkInTime }),
        ],
        [t("checkOut"), t("checkOutBy", { time: rules.checkOutTime })],
        [t("meals"), meals.length === 1 ? tHome(`choice.meal.${meals[0]}`) : t("mealsVary")],
        [
          t("children"),
          !rules.childrenEnabled
            ? t("childrenNo")
            : rules.adultAgeThreshold !== null
              ? t("childrenWelcomeAge", { age: rules.adultAgeThreshold })
              : t("childrenWelcome"),
        ],
      ]
    : [];
  // Announced once, above; the copy in the closed-by-default rules section is quiet.
  const rulesState = (live: boolean) =>
    rulesFailed ? (
      <div
        role={live ? "alert" : undefined}
        className="rounded-xl bg-red-50 p-4 text-sm text-red-700"
      >
        <p className="font-semibold">{t("rulesFailed")}</p>
        <button
          type="button"
          className="mt-2 font-semibold text-red-800 underline"
          onClick={onRetryRules}
        >
          {t("retry")}
        </button>
      </div>
    ) : (
      <p role={live ? "status" : undefined} className="text-sm text-gray-600">
        {t("rulesLoading")}
      </p>
    );
  return (
    <>
      <section aria-label={t("title")} className={`${card} space-y-[18px]`}>
        <h2 className="text-xl font-bold text-gray-900">{t("title")}</h2>
        {rules ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-sm text-gray-600">{label}</dt>
                <dd className="text-[15px] font-bold text-gray-900">{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          rulesState(true)
        )}
        <p className="text-sm text-gray-600">
          {hotelCountry ? t("timesLocalIn", { country: hotelCountry }) : t("timesLocal")}
        </p>
        {blocks.map((block) => (
          <div key={block.key} className="border-t border-gray-100 pt-4">
            <CancellationPolicy
              block={block}
              titled={blocks.length > 1}
              formatMoney={formatMoney}
            />
          </div>
        ))}
        <Section title={t("guestRules")}>
          {rules ? (
            <ul className="list-disc space-y-1.5 pl-5 text-[15px] text-gray-800">
              {ruleSentences(rules, t).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            rulesState(false)
          )}
        </Section>
        {termsText && (
          <Section title={t("terms")} scroll>
            <div className="whitespace-pre-wrap break-words text-[15px] text-gray-800">
              {termsText}
            </div>
          </Section>
        )}
      </section>
      {status && (
        <div role="status" className="text-sm text-gray-600">
          {status}
        </div>
      )}
      <ConsentTile
        label={termsText ? t("agree") : t("agreeNoTerms")}
        checked={agreed}
        disabled={consentDisabled}
        errorId={consentErrorId}
        onChange={onAgree}
      />
      {consentErrorId && !agreed && !consentDisabled && (
        <p
          id={consentErrorId}
          role="alert"
          className="flex items-start gap-2 text-sm font-medium text-red-700"
        >
          <svg
            className="mt-0.5 h-4 w-4 shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          {t("agreeMissing")}
        </p>
      )}
    </>
  );
}
