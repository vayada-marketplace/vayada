"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ArrowPathIcon,
  CheckIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  LockClosedIcon,
  NoSymbolIcon,
  QuestionMarkCircleIcon,
  ShieldCheckIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { PlainText } from "@vayada/web-security/plain-text";

import type { AssistantApi, PendingActionState, PendingActionView } from "./assistantApi";
import { dateLocale, fill, type ChangeMessages } from "./assistantMessages";

/**
 * vayada's Yes/No card for a change the AI asked for (VAY-2519 part 2; boards 03, 04 and 07). Its
 * words come from the API (VAY-2524), written by vayada from the stored change, never by the model.
 * Only its Yes button makes the change; after the answer the card changes in place.
 */

/** How often a change being made is read again, and a waiting one shortly after it expires. */
export const CHANGE_POLL_MS = 2_000;

/** undefined: loading; null: there is no card to show (changes off, or the read failed). */
export type CardStatus = PendingActionView | null | undefined;

const FINAL: readonly PendingActionState[] = [
  "done",
  "declined",
  "expired",
  "changed",
  "not_allowed",
  "stopped",
  "failed",
  "unsure",
];

export function timeOf(value: string | null, locale: string): string {
  if (!value) return "";
  return new Intl.DateTimeFormat(dateLocale(locale), { hour: "2-digit", minute: "2-digit" }).format(
    new Date(value),
  );
}

/** "Yes, block room 12" → "block room 12": what the waiting bar names. */
export function changeSubject(view: PendingActionView): string {
  const card = view.card;
  if (!card) return "";
  const subject = card.yesLabel.replace(/^(yes|ja)\s*,?\s*/i, "").trim();
  return subject && subject !== card.yesLabel ? subject : card.question.replace(/\?$/, "");
}

const titleOf = (view: PendingActionView) =>
  view.state === "done"
    ? (view.card?.doneTitle ?? "")
    : (view.card?.question.replace(/\?$/, "") ?? "");

export function ChangeCard({
  api,
  id,
  m,
  locale,
  onView,
  onAskAgain,
}: {
  api: AssistantApi;
  id: string;
  m: ChangeMessages;
  locale: string;
  /** Tells the panel how the change stands (for the waiting bar); undefined once the card is gone. */
  onView: (id: string, view: CardStatus) => void;
  /** Asks the turn's question again (expired, changed); absent when it can't be asked now. */
  onAskAgain?: () => void;
}) {
  const [view, setView] = useState<CardStatus>(undefined);
  const [busy, setBusy] = useState<"yes" | "no" | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setView((await api.pendingAction(id)) ?? null);
    } catch {
      setView(null);
    }
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onView(id, view);
  }, [id, view, onView]);
  useEffect(() => () => onView(id, undefined), [id, onView]);

  // Being made: read again until it ends. Waiting: read again once it expires.
  useEffect(() => {
    if (!view) return;
    const delay =
      view.state === "running"
        ? CHANGE_POLL_MS
        : view.state === "needs_answer" && view.answerBy
          ? Math.max(CHANGE_POLL_MS, Date.parse(view.answerBy) - Date.now() + 1_000)
          : undefined;
    if (delay === undefined) return;
    const timer = setTimeout(() => void load(), delay);
    return () => clearTimeout(timer);
  }, [view, load]);

  const answer = async (given: "yes" | "no") => {
    if (!view || busy) return;
    setBusy(given);
    setFailed(false);
    try {
      setView((await api.answer(view, given)).view);
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  if (view === undefined)
    return (
      <div className="rounded-xl border border-gray-200 px-4 py-3 text-[13px] text-gray-500">
        {m.loading}
      </div>
    );
  if (view === null)
    return (
      <div className="rounded-xl border border-gray-200 px-4 py-3 text-[13px] text-gray-500">
        {m.unavailable}
      </div>
    );

  const card = view.card;
  if (view.state === "needs_answer" || view.state === "running") {
    const running = view.state === "running";
    return (
      <section
        id={`change-${view.id}`}
        aria-label={m.needsAnswer}
        className="overflow-hidden rounded-xl border-2 border-primary-600 bg-white"
      >
        <header className="flex items-center justify-between gap-2 bg-primary-50 px-3.5 py-2 text-[13px] font-semibold text-primary-700">
          <span className="flex items-center gap-1.5">
            <ShieldCheckIcon className="h-4 w-4" aria-hidden="true" />
            {running ? m.running : m.needsAnswer}
          </span>
          {!running && view.answerBy && (
            <span className="text-xs font-medium">
              {fill(m.answerBy, { time: timeOf(view.answerBy, locale) })}
            </span>
          )}
        </header>
        <div className="px-3.5 pb-3.5 pt-3">
          {card ? (
            <>
              <h4 className="text-base font-semibold text-gray-900">
                <PlainText text={card.question} />
              </h4>
              {card.details.length > 0 && (
                <dl className="mt-3 divide-y divide-gray-200 rounded-lg border border-gray-200 text-sm">
                  {card.details.map((detail) => (
                    <div key={detail.label} className="flex gap-3 px-2.5 py-2">
                      <dt className="w-[72px] shrink-0 text-[13px] text-gray-500">
                        {detail.label}
                      </dt>
                      <dd className="min-w-0 text-gray-900">
                        <PlainText text={detail.value} />
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {card.effects.length > 0 && (
                <>
                  <p className="mt-3 text-[13px] font-semibold text-gray-900">{m.whatElse}</p>
                  <ul className="mt-1 space-y-1 text-sm text-gray-700">
                    {card.effects.map((effect) => (
                      <li key={effect} className="flex gap-2">
                        <span
                          aria-hidden="true"
                          className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-gray-400"
                        />
                        <PlainText text={effect} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {!running && view.cardSha256 && (
                <div className="mt-3.5 flex gap-2">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void answer("no")}
                    className="inline-flex h-9 items-center rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                  >
                    {m.no}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void answer("yes")}
                    className="inline-flex h-9 flex-1 items-center justify-center rounded-md bg-primary-600 px-4 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-60"
                  >
                    {card.yesLabel}
                  </button>
                </div>
              )}
              {failed && (
                <p className="mt-2 text-[13px] text-red-700" role="alert">
                  {m.answerFailed}
                </p>
              )}
              <p className="mt-2.5 text-xs text-gray-500">{m.footnote}</p>
            </>
          ) : (
            <p className="text-sm text-gray-600">{m.gone}</p>
          )}
        </div>
      </section>
    );
  }

  const outcome = OUTCOMES[view.state as Exclude<PendingActionState, "needs_answer" | "running">];
  const when = timeOf(
    view.state === "done" || view.state === "declined" ? view.answeredAt : view.finishedAt,
    locale,
  );
  const body = fill(m[outcome.body], {
    time: timeOf(view.answeredAt ?? view.finishedAt, locale),
  });
  return (
    <section
      id={`change-${view.id}`}
      className={`overflow-hidden rounded-xl border ${outcome.frame}`}
    >
      <header
        className={`flex items-center justify-between gap-2 px-3.5 py-2 text-[13px] font-semibold ${outcome.head}`}
      >
        <span className="flex items-center gap-1.5">
          {outcome.icon}
          {m[outcome.label]}
        </span>
        {when && <span className="text-xs font-medium">{when}</span>}
      </header>
      <div className="bg-white px-3.5 pb-3 pt-2.5">
        {card && (
          <h4 className="text-[15px] font-semibold text-gray-900">
            <PlainText text={titleOf(view)} />
          </h4>
        )}
        <p className="mt-1 text-sm text-gray-600">{body}</p>
        {outcome.askAgain && onAskAgain && (
          <button
            type="button"
            onClick={onAskAgain}
            className="mt-1.5 text-sm font-medium text-primary-600 hover:text-primary-700"
          >
            {m.askAgain}
          </button>
        )}
      </div>
    </section>
  );
}

type Outcome = {
  label: keyof ChangeMessages;
  body: keyof ChangeMessages;
  icon: ReactNode;
  frame: string;
  head: string;
  askAgain?: boolean;
};

const GREY = { frame: "border-gray-200", head: "bg-gray-50 text-gray-700" };
const icon = (Icon: typeof CheckIcon) => <Icon className="h-4 w-4" aria-hidden="true" />;

const OUTCOMES: Record<(typeof FINAL)[number], Outcome> = {
  done: {
    label: "done",
    body: "doneBody",
    icon: icon(CheckIcon),
    frame: "border-green-200",
    head: "bg-green-50 text-green-700",
  },
  declined: { label: "declined", body: "declinedBody", icon: icon(XMarkIcon), ...GREY },
  expired: {
    label: "expired",
    body: "expiredBody",
    icon: icon(ClockIcon),
    ...GREY,
    askAgain: true,
  },
  changed: {
    label: "changed",
    body: "changedBody",
    icon: icon(ArrowPathIcon),
    frame: "border-amber-200",
    head: "bg-amber-50 text-amber-800",
    askAgain: true,
  },
  not_allowed: { label: "notAllowed", body: "notAllowedBody", icon: icon(LockClosedIcon), ...GREY },
  stopped: { label: "stopped", body: "stoppedBody", icon: icon(NoSymbolIcon), ...GREY },
  failed: {
    label: "failed",
    body: "failedBody",
    icon: icon(ExclamationTriangleIcon),
    frame: "border-red-200",
    head: "bg-red-50 text-red-700",
  },
  unsure: {
    label: "unsure",
    body: "unsureBody",
    icon: icon(QuestionMarkCircleIcon),
    frame: "border-amber-200",
    head: "bg-amber-50 text-amber-800",
  },
};

/** The waiting bar above the question box (board 04): a change still waits for an answer. */
export function WaitingBar({
  view,
  m,
  locale,
}: {
  view: PendingActionView;
  m: ChangeMessages;
  locale: string;
}) {
  return (
    <div
      role="status"
      className="mb-2 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900"
    >
      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-semibold">{m.waiting}</span> {changeSubject(view)}
        {view.answerBy && ` · ${fill(m.until, { time: timeOf(view.answerBy, locale) })}`}
      </span>
      <button
        type="button"
        className="shrink-0 font-semibold underline underline-offset-2 hover:text-amber-950"
        onClick={() =>
          document
            .getElementById(`change-${view.id}`)
            ?.scrollIntoView({ block: "center", behavior: "smooth" })
        }
      >
        {m.show}
      </button>
    </div>
  );
}
