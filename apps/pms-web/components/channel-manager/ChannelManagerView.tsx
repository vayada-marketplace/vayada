"use client";

import {
  ArrowPathIcon,
  ArrowRightIcon,
  CheckIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  GlobeAltIcon,
  InformationCircleIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import type { ReactNode } from "react";

import { useTranslation } from "@/lib/i18n";
import type { ChannelManagerView as View } from "@/services/channelManager";

import {
  listText,
  markupText,
  otaName,
  overallStatus,
  problemCards,
  stayText,
  whenText,
  type ProblemCard,
} from "./channelManagerText";

const MARKETING_BASE_URL = process.env.NEXT_PUBLIC_MARKETING_URL || "https://vayada.com";
const CONTACT_URL = `${MARKETING_BASE_URL}/contact`;
const MEAL_PLANS = new Set(["room_only", "breakfast", "half_board", "full_board", "all_inclusive"]);

/**
 * VAY-2606: the Channel manager, view only (Paper "VAY-2606 Channel manager v1", approved 2026-11-26). The only
 * button that changes anything is "Mark as seen", and only account admins get it.
 */
export function ChannelManagerView({
  view,
  canMarkSeen,
  markingSeen,
  markSeenFailed,
  onMarkSeen,
  now = new Date(),
}: {
  view: View;
  canMarkSeen: boolean;
  markingSeen: string | null;
  markSeenFailed: boolean;
  onMarkSeen: (alertId: string) => void;
  now?: Date;
}) {
  const { t, locale } = useTranslation();
  const problems = problemCards(view, locale, t, now);
  const status = overallStatus(view, problems);

  return (
    <div className="p-4 md:p-6">
      <div className="flex max-w-[1080px] flex-col gap-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">{t("channelManager.title")}</h1>
            <p className="mt-1 text-sm leading-[22px] text-gray-500">
              {t("channelManager.subtitle")}
            </p>
          </div>
          <StatusBadge status={status} />
        </div>

        {status === "notConnected" ? (
          <NotConnected />
        ) : (
          <>
            {problems.length > 0 && (
              <Problems
                problems={problems}
                canMarkSeen={canMarkSeen}
                markingSeen={markingSeen}
                markSeenFailed={markSeenFailed}
                onMarkSeen={onMarkSeen}
              />
            )}
            <div className="flex flex-col items-start gap-5 lg:flex-row">
              <div className="flex w-full min-w-0 flex-col gap-5 lg:[flex:1.4_1_0%]">
                <Channels view={view} />
                <Rooms view={view} />
              </div>
              <div className="flex w-full min-w-0 flex-col gap-5 lg:[flex:1_1_0%]">
                <Sync view={view} now={now} />
                {problems.length === 0 && (
                  <Card title={t("channelManager.problems.title")}>
                    <div className="flex flex-col gap-1.5 pt-3">
                      <p className="text-[13px] font-medium leading-5 text-gray-900">
                        {t("channelManager.problems.none")}
                      </p>
                      <p className="text-xs leading-[18px] text-gray-500">
                        {t("channelManager.problems.noneHint")}
                      </p>
                    </div>
                  </Card>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: "connected" | "attention" | "notConnected" }) {
  const { t } = useTranslation();
  const style = {
    connected: ["border-green-200 bg-green-50 text-green-700", "bg-green-500"],
    attention: ["border-amber-200 bg-amber-50 text-amber-700", "bg-amber-500"],
    notConnected: ["border-gray-200 bg-white text-gray-600", "bg-gray-400"],
  }[status];
  return (
    <span
      className={`inline-flex w-fit shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${style[0]}`}
    >
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${style[1]}`} />
      {t(`channelManager.status.${status}`)}
    </span>
  );
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex w-full flex-col rounded-xl border border-gray-200 bg-white p-6"
    >
      <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      {subtitle && <p className="pt-0.5 text-[13px] leading-5 text-gray-500">{subtitle}</p>}
      {children}
    </section>
  );
}

function SellingStatus({ selling, label }: { selling: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={`h-2 w-2 shrink-0 rounded-full ${selling ? "bg-green-500" : "bg-gray-300"}`}
      />
      <span
        className={`text-[13px] font-medium leading-4 ${selling ? "text-green-700" : "text-gray-500"}`}
      >
        {label}
      </span>
    </span>
  );
}

const headCell =
  "pb-2 text-[11px] font-semibold uppercase leading-[14px] tracking-wider text-gray-500";

function Channels({ view }: { view: View }) {
  const { t, locale } = useTranslation();
  const channels = view.channels;
  return (
    <Card
      title={t("channelManager.channels.title")}
      subtitle={t("channelManager.channels.subtitle")}
    >
      {channels.status === "unavailable" ? (
        <p className="mt-4 rounded-lg bg-gray-50 px-3 py-2.5 text-xs leading-[18px] text-gray-600">
          {t("channelManager.channels.unavailable")}
        </p>
      ) : channels.items.length === 0 ? (
        <p className="mt-4 rounded-lg bg-gray-50 px-3 py-2.5 text-xs leading-[18px] text-gray-600">
          {t("channelManager.channels.none")}
        </p>
      ) : (
        <div className="overflow-x-auto pb-1 pt-4">
          <table className="w-full min-w-[320px] table-fixed text-left">
            <colgroup>
              <col />
              <col className="w-[110px]" />
              <col className="w-[90px]" />
            </colgroup>
            <thead>
              <tr className="border-b border-gray-100">
                <th className={headCell}>{t("channelManager.channels.columnChannel")}</th>
                <th className={headCell}>{t("channelManager.channels.columnStatus")}</th>
                <th className={`${headCell} text-right`}>
                  {t("channelManager.channels.columnMarkup")}
                </th>
              </tr>
            </thead>
            <tbody>
              {channels.items.map((channel, index) => {
                const rooms =
                  channel.ota === "booking_com"
                    ? t(
                        `channelManager.channels.rooms.${channel.mappedCount === 1 ? "one" : "other"}`,
                        {
                          count: channel.mappedCount,
                        },
                      )
                    : t(
                        `channelManager.channels.listings.${channel.mappedCount === 1 ? "one" : "other"}`,
                        { count: channel.mappedCount },
                      );
                const detail = [
                  channel.otaPropertyId
                    ? t("channelManager.channels.property", { id: channel.otaPropertyId })
                    : null,
                  rooms,
                ]
                  .filter(Boolean)
                  .join(" · ");
                const markup = markupText(channel.markup, locale, t);
                return (
                  <tr
                    key={`${channel.ota}:${index}`}
                    className={index < channels.items.length - 1 ? "border-b border-gray-100" : ""}
                  >
                    <td className="py-3.5 pr-4 align-middle">
                      <p className="text-sm font-semibold text-gray-900">
                        {otaName(channel.ota, t)}
                      </p>
                      <p className="text-xs leading-[18px] text-gray-500">{detail}</p>
                    </td>
                    <td className="py-3.5 pr-4 align-middle">
                      <SellingStatus
                        selling={channel.active}
                        label={t(
                          channel.active
                            ? "channelManager.channels.selling"
                            : "channelManager.channels.notSelling",
                        )}
                      />
                    </td>
                    <td
                      className="py-3.5 text-right align-middle text-sm font-semibold leading-[18px] text-gray-900"
                      title={
                        channel.markup.kind === "unknown"
                          ? t("channelManager.channels.markupUnknown")
                          : undefined
                      }
                    >
                      {markup}
                      {channel.markup.kind === "unknown" && (
                        <span className="sr-only">
                          {t("channelManager.channels.markupUnknown")}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2.5 text-xs leading-[18px] text-gray-600">
        <InformationCircleIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-gray-500" />
        {t("channelManager.channels.contactNote")}
      </p>
    </Card>
  );
}

function Rooms({ view }: { view: View }) {
  const { t, locale } = useTranslation();
  const closed = view.rooms.filter((room) => room.notSellingReason === "sales_closed");
  const noNights = view.rooms.filter((room) => room.notSellingReason === "no_open_nights");
  const names = (rooms: typeof view.rooms) =>
    listText(Array.from(new Set(rooms.map((room) => room.roomTypeName))), locale);
  const plural = (rooms: typeof view.rooms) =>
    new Set(rooms.map((room) => room.roomTypeName)).size === 1 ? "one" : "other";
  return (
    <Card title={t("channelManager.rooms.title")} subtitle={t("channelManager.rooms.subtitle")}>
      {view.rooms.length === 0 ? (
        <p className="mt-4 rounded-lg bg-gray-50 px-3 py-2.5 text-xs leading-[18px] text-gray-600">
          {t("channelManager.rooms.none")}
        </p>
      ) : (
        <div className="overflow-x-auto pt-4">
          <table className="w-full min-w-[480px] table-fixed text-left">
            <colgroup>
              <col />
              <col className="w-[150px]" />
              <col className="w-[90px]" />
              <col className="w-[110px]" />
            </colgroup>
            <thead>
              <tr className="border-b border-gray-100">
                <th className={headCell}>{t("channelManager.rooms.columnRoom")}</th>
                <th className={headCell}>{t("channelManager.rooms.columnSoldAs")}</th>
                <th className={headCell}>{t("channelManager.rooms.columnGuests")}</th>
                <th className={headCell}>{t("channelManager.rooms.columnStatus")}</th>
              </tr>
            </thead>
            <tbody>
              {view.rooms.map((room, index) => (
                <tr
                  key={room.targetId}
                  className={index < view.rooms.length - 1 ? "border-b border-gray-100" : ""}
                >
                  <td className="py-3 pr-4 text-[13px] font-semibold leading-4 text-gray-900">
                    {room.roomTypeName}
                  </td>
                  <td className="py-3 pr-4 text-[13px] leading-4 text-gray-700">
                    {room.mealPlan && MEAL_PLANS.has(room.mealPlan)
                      ? t(`channelManager.mealPlan.${room.mealPlan}`)
                      : "—"}
                  </td>
                  <td className="py-3 pr-4 text-[13px] leading-4 text-gray-700">
                    {room.maxGuests
                      ? t("channelManager.rooms.upTo", { count: room.maxGuests })
                      : "—"}
                  </td>
                  <td className="py-3">
                    <SellingStatus
                      selling={room.selling}
                      label={t(
                        room.selling
                          ? "channelManager.rooms.selling"
                          : "channelManager.rooms.notSelling",
                      )}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {noNights.length > 0 && (
        <p className="pt-2 text-xs leading-[18px] text-gray-500">
          {t(`channelManager.rooms.noOpenNights.${plural(noNights)}`, { rooms: names(noNights) })}
        </p>
      )}
      {closed.length > 0 && (
        <p className="pt-2 text-xs leading-[18px] text-gray-500">
          {t(`channelManager.rooms.salesClosed.${plural(closed)}`, { rooms: names(closed) })}
        </p>
      )}
    </Card>
  );
}

function Sync({ view, now }: { view: View; now: Date }) {
  const { t, locale } = useTranslation();
  const { prices, bookings } = view.sync;
  const when = (iso: string | null, key: "lastSent" | "lastChecked") =>
    iso ? t(`channelManager.sync.${key}`, { when: whenText(iso, locale, t, now) }) : null;
  const line = (...parts: Array<string | null>) => parts.filter(Boolean).join(" · ");
  const latest = bookings.latest;
  return (
    <Card title={t("channelManager.sync.title")} subtitle={t("channelManager.sync.subtitle")}>
      <div className="flex flex-col gap-3 pt-4">
        <SyncRow
          state={prices.status}
          title={t("channelManager.sync.prices")}
          line={
            prices.status === "never"
              ? t("channelManager.sync.notSentYet")
              : line(
                  t(
                    prices.status === "ok"
                      ? "channelManager.sync.upToDate"
                      : prices.status === "partial"
                        ? "channelManager.sync.someRoomsLeftOut"
                        : prices.status === "retrying"
                          ? "channelManager.sync.retrying"
                          : "channelManager.sync.notReaching",
                  ),
                  when(prices.lastSuccessAt, "lastSent"),
                )
          }
        />
        <SyncRow
          state={bookings.status}
          title={t("channelManager.sync.bookings")}
          line={
            bookings.status === "never"
              ? t("channelManager.sync.notCheckedYet")
              : line(
                  t(
                    bookings.status === "ok"
                      ? "channelManager.sync.upToDate"
                      : bookings.status === "retrying"
                        ? "channelManager.sync.retrying"
                        : "channelManager.sync.notChecking",
                  ),
                  when(bookings.lastCheckedAt, "lastChecked"),
                )
          }
          extra={
            latest
              ? t("channelManager.sync.latest", {
                  booking: [
                    otaName(latest.channel, t),
                    latest.roomTypeName,
                    stayText(latest.checkIn, latest.checkOut, locale, now),
                  ]
                    .filter(Boolean)
                    .join(", "),
                })
              : null
          }
        />
      </div>
    </Card>
  );
}

function SyncRow({
  state,
  title,
  line,
  extra = null,
}: {
  state: "ok" | "partial" | "retrying" | "failed" | "never";
  title: string;
  line: string;
  extra?: string | null;
}) {
  const [circle, icon] = {
    ok: ["bg-green-50", <CheckIcon key="ok" className="h-4 w-4 text-green-600" strokeWidth={2} />],
    retrying: [
      "bg-amber-50",
      <ArrowPathIcon key="retrying" className="h-4 w-4 text-amber-600" strokeWidth={2} />,
    ],
    failed: [
      "bg-amber-50",
      <ExclamationTriangleIcon key="failed" className="h-4 w-4 text-amber-600" strokeWidth={2} />,
    ],
    partial: [
      "bg-amber-50",
      <ExclamationTriangleIcon key="partial" className="h-4 w-4 text-amber-600" strokeWidth={2} />,
    ],
    never: [
      "bg-gray-100",
      <ClockIcon key="never" className="h-4 w-4 text-gray-500" strokeWidth={2} />,
    ],
  }[state] as [string, ReactNode];
  return (
    <div className="flex items-start gap-3 rounded-lg border border-gray-200 p-3.5">
      <span
        aria-hidden="true"
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${circle}`}
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-[13px] font-semibold leading-5 text-gray-900">{title}</p>
        <p className="text-xs leading-[18px] text-gray-600">{line}</p>
        {extra && <p className="text-xs leading-[18px] text-gray-500">{extra}</p>}
      </div>
    </div>
  );
}

function Problems({
  problems,
  canMarkSeen,
  markingSeen,
  markSeenFailed,
  onMarkSeen,
}: {
  problems: readonly ProblemCard[];
  canMarkSeen: boolean;
  markingSeen: string | null;
  markSeenFailed: boolean;
  onMarkSeen: (alertId: string) => void;
}) {
  const { t } = useTranslation();
  const open = t(`channelManager.problems.open.${problems.length === 1 ? "one" : "other"}`, {
    count: problems.length,
  });
  return (
    <section
      aria-label={t("channelManager.problems.title")}
      className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-white p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-base font-semibold text-gray-900">
          {t("channelManager.problems.title")}
        </h2>
        <p className="text-xs leading-[18px] text-gray-500">
          {canMarkSeen ? open : `${open} · ${t("channelManager.problems.adminsMarkSeen")}`}
        </p>
      </div>
      {markSeenFailed && (
        <p role="alert" className="text-sm text-red-700">
          {t("channelManager.problems.markSeenError")}
        </p>
      )}
      {problems.map((problem) => (
        <article
          key={problem.key}
          className={`flex flex-col gap-3 rounded-[10px] p-4 sm:flex-row sm:items-start sm:gap-3.5 ${problem.retrying ? "bg-gray-50" : "bg-amber-50"}`}
        >
          <div className="flex min-w-0 flex-1 items-start gap-3.5">
            <span
              aria-hidden="true"
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${problem.retrying ? "bg-gray-100" : "bg-amber-100"}`}
            >
              {problem.retrying ? (
                <ArrowPathIcon className="h-4 w-4 text-gray-600" strokeWidth={2} />
              ) : (
                <ExclamationTriangleIcon className="h-4 w-4 text-amber-600" strokeWidth={2} />
              )}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h3 className="text-sm font-semibold text-gray-900">{problem.title}</h3>
              <p className="text-[13px] leading-5 text-gray-700">{problem.body}</p>
              {problem.meta && (
                <p className="text-xs leading-[18px] text-gray-500">{problem.meta}</p>
              )}
            </div>
          </div>
          {(problem.openCalendar || problem.alertId) && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 pl-[42px] sm:pl-0">
              {problem.openCalendar && (
                <Link
                  href="/calendar"
                  className="inline-flex h-9 items-center rounded-lg border border-gray-300 bg-white px-3.5 text-[13px] font-semibold leading-4 text-gray-800 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2"
                >
                  {t("channelManager.problems.openCalendar")}
                </Link>
              )}
              {problem.alertId && problem.seen && (
                <span className="text-xs font-medium text-gray-500">
                  {t("channelManager.problems.seen")}
                </span>
              )}
              {problem.alertId && !problem.seen && canMarkSeen && (
                <button
                  type="button"
                  onClick={() => onMarkSeen(problem.alertId!)}
                  disabled={markingSeen !== null}
                  className="inline-flex h-9 items-center rounded-lg bg-gray-900 px-3.5 text-[13px] font-semibold leading-4 text-white hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t("channelManager.problems.markSeen")}
                </button>
              )}
            </div>
          )}
        </article>
      ))}
    </section>
  );
}

function NotConnected() {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t("channelManager.notConnected.title")}
      className="flex max-w-[640px] flex-col gap-4 rounded-xl border border-gray-200 bg-white p-7"
    >
      <span
        aria-hidden="true"
        className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-gray-100"
      >
        <GlobeAltIcon className="h-5 w-5 text-gray-600" strokeWidth={1.5} />
      </span>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-base font-semibold text-gray-900">
          {t("channelManager.notConnected.title")}
        </h2>
        <p className="text-sm leading-[22px] text-gray-600">
          {t("channelManager.notConnected.body")}
        </p>
      </div>
      <a
        href={CONTACT_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-2 text-[13px] font-semibold leading-4 text-primary-600 hover:text-primary-700"
      >
        {t("channelManager.contactTeam")}
        <ArrowRightIcon aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2} />
      </a>
    </section>
  );
}
