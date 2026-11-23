"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { SettingsSubPage } from "@/components/settings/SettingsSubPage";
import {
  filterLines,
  formatMinor,
  formatPayoutDay,
  isNegative,
  lineFigures,
  lineLabel,
  lineNote,
  maskedAccount,
  type StatementFilter,
} from "@/components/settings/payoutStatement";
import { useTranslation } from "@/lib/i18n";
import { getBookingHotelPropertyLink } from "@/services/api/bookingPropertyLinkClient";
import {
  getSelectedBookingHotelId,
  SELECTED_HOTEL_CHANGED_EVENT,
} from "@/services/api/bookingHotelScope";
import { ApiErrorResponse } from "@/services/api/client";
import {
  getPayoutStatement,
  type PayoutStatement,
  type PayoutStatementPayout,
  type PayoutStatementTotals,
} from "@/services/api/financePayoutStatementClient";
import { settingsService } from "@/services/settings";

const CARD = "rounded-xl border border-gray-200 bg-white";
const TONE = {
  negative: "text-red-600",
  positive: "text-green-700",
  plain: "text-gray-900",
} as const;
const PAYOUT_STATUS_TONE: Record<PayoutStatementPayout["status"], string> = {
  sending: "text-gray-900",
  sent: "text-gray-900",
  returned: "text-amber-700",
  cancelled: "text-gray-500",
};
const FILTERS: StatementFilter[] = ["all", "card", "deductions"];

type State =
  | { kind: "loading" }
  | { kind: "failed" }
  /** Staff without the owner's permission: payouts are the owner's (VAY-2401). */
  | { kind: "ownerOnly" }
  /** Refused for another reason (not this hotel's member, no active plan for it). */
  | { kind: "noAccess" }
  /** vayada Payment isn't set up for the hotel, or nothing has been paid through it yet. */
  | { kind: "empty" }
  | { kind: "ready"; statement: PayoutStatement };

/** Settings › Payouts (VAY-2584): what vayada Payment owes the hotel and when, each Monday payout
 * and every line behind it (card payments, fees, refunds, disputes and their fees, returned
 * payouts). Owner only, like the payout account. */
export function PayoutStatementPage({
  load = getPayoutStatement,
}: {
  load?: (propertyId: string) => Promise<PayoutStatement>;
}) {
  const { t, locale } = useTranslation();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [filter, setFilter] = useState<StatementFilter>("all");
  // The latest load wins: an older hotel's answer must never replace the current one.
  const loadVersion = useRef(0);
  const loadingHotelId = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const version = ++loadVersion.current;
    const current = () => version === loadVersion.current;
    setState({ kind: "loading" });
    try {
      const hotelId =
        getSelectedBookingHotelId() || (await settingsService.getPropertySettings()).id || null;
      if (!hotelId) throw new Error("No booking hotel selected");
      if (!current()) return;
      loadingHotelId.current = hotelId;
      const { propertyId } = await getBookingHotelPropertyLink({ hotelId });
      const statement = await load(propertyId);
      if (!current()) return;
      setState(
        statement.lines.length === 0 && statement.payouts.length === 0
          ? { kind: "empty" }
          : { kind: "ready", statement },
      );
    } catch (error) {
      if (!current()) return;
      const status = error instanceof ApiErrorResponse ? error.status : null;
      const code = error instanceof ApiErrorResponse ? error.data?.code : undefined;
      setState({
        kind:
          status === 403
            ? code === "missing_permission"
              ? "ownerOnly"
              : "noAccess"
            : status === 404
              ? "empty"
              : "failed",
      });
    }
  }, [load]);

  useEffect(() => {
    void refresh();
    const onHotelSelected = () => {
      if (getSelectedBookingHotelId() !== loadingHotelId.current) void refresh();
    };
    window.addEventListener(SELECTED_HOTEL_CHANGED_EVENT, onHotelSelected);
    return () => {
      loadVersion.current += 1;
      window.removeEventListener(SELECTED_HOTEL_CHANGED_EVENT, onHotelSelected);
    };
  }, [refresh]);

  const day = (date: string) => formatPayoutDay(date, locale);

  return (
    <SettingsSubPage
      title={t("settings.payouts.title")}
      subtitle={t("settings.payouts.intro")}
      wide
    >
      <div className="mt-6 space-y-5" data-testid="payout-statement">
        {state.kind === "loading" && (
          <div className="grid gap-4 sm:grid-cols-3" aria-busy="true">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-32 animate-pulse rounded-xl bg-gray-100" />
            ))}
          </div>
        )}
        {state.kind === "failed" && (
          <div className={`${CARD} flex flex-wrap items-center justify-between gap-3 px-5 py-4`}>
            <p className="text-sm text-red-700">{t("settings.payouts.loadError")}</p>
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-[13px] font-medium text-gray-700 hover:bg-gray-50"
            >
              {t("settings.billing.vayadaPayout.retry")}
            </button>
          </div>
        )}
        {state.kind === "ownerOnly" && (
          <div
            className="max-w-3xl rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-amber-900"
            data-testid="payout-statement-owner-only"
          >
            <p className="text-sm font-semibold">{t("settings.payouts.ownerOnlyTitle")}</p>
            <p className="mt-1 text-sm">{t("settings.payouts.ownerOnlyText")}</p>
          </div>
        )}
        {state.kind === "noAccess" && (
          <div
            className="max-w-3xl rounded-xl border border-gray-200 bg-white px-5 py-4 text-sm text-gray-700"
            data-testid="payout-statement-no-access"
          >
            {t("settings.payouts.noAccess")}
          </div>
        )}
        {state.kind === "empty" && (
          <div className={`${CARD} px-7 py-9`} data-testid="payout-statement-empty">
            <p className="text-[17px] font-semibold text-gray-900">
              {t("settings.payouts.emptyTitle")}
            </p>
            <p className="mt-2 max-w-2xl text-sm leading-[22px] text-gray-500">
              {t("settings.payouts.emptyText")}
            </p>
            <Link
              href="/settings/payments"
              className="mt-5 inline-flex rounded-full bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700"
            >
              {t("settings.payouts.goToPayments")}
            </Link>
          </div>
        )}
        {state.kind === "ready" && (
          <>
            {state.statement.totals.map((totals) => (
              <TotalsRow
                key={totals.currency}
                totals={totals}
                account={state.statement.account?.accountLast4 ?? null}
                day={day}
              />
            ))}
            <section className={`${CARD} p-5`} aria-labelledby="payouts-heading">
              <h2 id="payouts-heading" className="text-[17px] font-semibold text-gray-900">
                {t("settings.payouts.payoutsTitle")}
              </h2>
              {state.statement.payouts.length === 0 ? (
                <p className="mt-3 text-sm text-gray-500">{t("settings.payouts.noPayouts")}</p>
              ) : (
                <div className="mt-3">
                  <div className="hidden gap-3 pb-2 text-xs font-semibold text-gray-500 md:flex">
                    <span className="w-[200px] shrink-0">{t("settings.payouts.colSent")}</span>
                    <span className="w-[220px] shrink-0">{t("settings.payouts.colAmount")}</span>
                    <span className="w-[200px] shrink-0">{t("settings.payouts.colTo")}</span>
                    <span className="min-w-0 flex-1">{t("settings.payouts.colStatus")}</span>
                  </div>
                  <ul>
                    {state.statement.payouts.map((payout) => (
                      <PayoutRow key={payout.id} payout={payout} day={day} />
                    ))}
                  </ul>
                </div>
              )}
            </section>
            <section className={`${CARD} p-5`} aria-labelledby="statement-heading">
              <div className="flex flex-wrap items-center gap-3">
                <h2
                  id="statement-heading"
                  className="flex-1 text-[17px] font-semibold text-gray-900"
                >
                  {t("settings.payouts.statementTitle")}
                </h2>
                <div className="flex flex-wrap gap-2" role="group">
                  {FILTERS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={filter === option}
                      onClick={() => setFilter(option)}
                      className={`rounded-full border px-3 py-1.5 text-[13px] font-medium ${
                        filter === option
                          ? "border-primary-600 bg-primary-50 text-primary-600"
                          : "border-gray-200 bg-white text-slate-700 hover:bg-gray-50"
                      }`}
                    >
                      {t(`settings.payouts.filter.${option}`)}
                    </button>
                  ))}
                </div>
              </div>
              <StatementLines
                statement={state.statement}
                filter={filter}
                day={day}
                t={t}
                locale={locale}
              />
              <p className="mt-4 text-xs leading-[18px] text-gray-500">
                {t("settings.payouts.footnote")}
              </p>
            </section>
          </>
        )}
      </div>
    </SettingsSubPage>
  );
}

function TotalsRow({
  totals,
  account,
  day,
}: {
  totals: PayoutStatementTotals;
  account: string | null;
  day: (date: string) => string;
}) {
  const { t } = useTranslation();
  const next = totals.nextPayout;
  const money = (minor: string) => formatMinor(minor, totals.currency);
  return (
    <div className="grid gap-4 sm:grid-cols-3" data-testid="payout-totals">
      <Total
        label={t("settings.payouts.nextPayout", { date: day(next.on) })}
        amount={money(next.amountMinor)}
        strong
        text={
          isNegative(next.balanceMinor)
            ? t("settings.payouts.nextPayoutOwed", {
                amount: money(next.balanceMinor.slice(1)),
              })
            : account
              ? t("settings.payouts.nextPayoutTo", {
                  cutoff: day(next.cutoff),
                  account: maskedAccount(account),
                })
              : t("settings.payouts.nextPayoutText", { cutoff: day(next.cutoff) })
        }
      />
      <Total
        label={t("settings.payouts.upcoming")}
        amount={money(totals.upcomingMinor)}
        text={t("settings.payouts.upcomingText", { cutoff: day(next.cutoff) })}
      />
      <Total
        label={t("settings.payouts.paidOut")}
        amount={money(totals.paidOutMinor)}
        text={
          totals.firstPaidOn
            ? t("settings.payouts.paidOutText", { date: day(totals.firstPaidOn) })
            : t("settings.payouts.paidOutNone")
        }
      />
    </div>
  );
}

function Total({
  label,
  amount,
  text,
  strong = false,
}: {
  label: string;
  amount: string;
  text: string;
  strong?: boolean;
}) {
  return (
    <div className={`${CARD} flex flex-col gap-1.5 px-5 py-[18px]`}>
      <p
        className={`text-xs font-semibold uppercase tracking-[0.04em] ${strong ? "text-primary-600" : "text-gray-500"}`}
      >
        {label}
      </p>
      <p className="text-[26px] font-bold text-gray-900">{amount}</p>
      <p className="text-[13px] leading-[19px] text-gray-500">{text}</p>
    </div>
  );
}

function PayoutRow({
  payout,
  day,
}: {
  payout: PayoutStatementPayout;
  day: (date: string) => string;
}) {
  const { t } = useTranslation();
  const status = t(`settings.payouts.status.${payout.status}`);
  const note =
    payout.status === "returned"
      ? t("settings.payouts.returnedNote")
      : payout.status === "cancelled"
        ? t("settings.payouts.cancelledNote")
        : null;
  return (
    <li className="border-t border-gray-200 py-[11px]" data-testid="payout-row">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-gray-900 md:flex-nowrap">
        <span className="md:w-[200px] md:shrink-0">
          {payout.paidOn
            ? day(payout.paidOn)
            : t("settings.payouts.startedOn", { date: day(payout.startedOn) })}
        </span>
        <span className="font-medium md:w-[220px] md:shrink-0 md:font-normal">
          {formatMinor(payout.amountMinor, payout.currency)}
        </span>
        <span className="text-gray-500 md:w-[200px] md:shrink-0 md:text-gray-900">
          {maskedAccount(payout.accountLast4)}
        </span>
        <span
          className={`w-full font-semibold md:w-auto md:min-w-0 md:flex-1 ${PAYOUT_STATUS_TONE[payout.status]}`}
        >
          {status}
        </span>
      </div>
      {note && <p className="mt-1 max-w-[760px] text-xs leading-[18px] text-gray-500">{note}</p>}
    </li>
  );
}

function StatementLines({
  statement,
  filter,
  day,
  t,
  locale,
}: {
  statement: PayoutStatement;
  filter: StatementFilter;
  day: (date: string) => string;
  t: (key: string, params?: Record<string, string | number>) => string;
  locale: string;
}) {
  const lines = filterLines(statement.lines, filter);
  if (lines.length === 0)
    return <p className="mt-4 text-sm text-gray-500">{t("settings.payouts.noLines")}</p>;
  const column = "shrink-0 text-right";
  return (
    <div className="mt-3">
      <div className="hidden gap-3 pb-2 text-xs font-semibold text-gray-500 lg:flex">
        <span className="w-24 shrink-0">{t("settings.payouts.colDate")}</span>
        <span className="min-w-0 flex-1">{t("settings.payouts.colWhat")}</span>
        <span className="w-24 shrink-0">{t("settings.payouts.colBooking")}</span>
        <span className="w-24 shrink-0">{t("settings.payouts.colCheckOut")}</span>
        <span className={`w-28 ${column}`}>{t("settings.payouts.colGross")}</span>
        <span className={`w-[104px] ${column}`}>{t("settings.payouts.colFees")}</span>
        <span className={`w-[120px] ${column}`}>{t("settings.payouts.colNet")}</span>
      </div>
      <ul>
        {lines.map((line) => {
          const figures = lineFigures(line);
          const label = lineLabel(line, statement.payouts, t);
          const note = lineNote(line, statement.payouts, t, locale);
          const booking = line.bookingReference ?? "—";
          const checkOut = line.checkOut ? day(line.checkOut) : "—";
          return (
            <li
              key={line.id}
              className="border-t border-gray-200 py-[11px]"
              data-testid="statement-line"
              data-kind={line.kind}
            >
              {/* Phones and tablets: what it is and what you get, then the details. */}
              <div className="lg:hidden">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 font-medium text-gray-900">{label}</span>
                  <span className={`shrink-0 font-semibold ${TONE[figures.tone]}`}>
                    {figures.net}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-gray-500">
                  {[day(line.occurredAt), line.bookingReference, line.checkOut && checkOut]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {(figures.amount || figures.fees) && (
                  <p className="mt-0.5 text-xs text-gray-500">
                    {[
                      figures.amount && `${t("settings.payouts.colGross")} ${figures.amount}`,
                      figures.fees && `${t("settings.payouts.colFees")} ${figures.fees}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
              </div>
              {/* Desktop: one row per line, columns lined up. */}
              <div className="hidden items-baseline gap-3 text-sm text-gray-900 lg:flex">
                <span className="w-24 shrink-0">{day(line.occurredAt)}</span>
                <span className="min-w-0 flex-1">{label}</span>
                <span className="w-24 shrink-0">{booking}</span>
                <span className="w-24 shrink-0">{checkOut}</span>
                <span
                  className={`w-28 ${column} ${isNegative(line.grossMinor) && figures.amount ? "text-red-600" : ""}`}
                >
                  {figures.amount}
                </span>
                <span
                  className={`w-[104px] ${column} ${isNegative(line.feeMinor) ? "" : "text-red-600"}`}
                >
                  {figures.fees}
                </span>
                <span className={`w-[120px] ${column} font-semibold ${TONE[figures.tone]}`}>
                  {figures.net}
                </span>
              </div>
              {note && (
                <p className="mt-1 max-w-[760px] text-xs leading-[18px] text-gray-500">{note}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
