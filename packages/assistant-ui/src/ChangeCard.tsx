"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
import { PlainText, toPlainText } from "@vayada/web-security/plain-text";

import type { AssistantApi, PendingActionState, PendingActionView } from "./assistantApi";
import { dateLocale, fill, type ChangeMessages } from "./assistantMessages";

/**
 * vayada's Yes/No card for a change the AI asked for (VAY-2519 part 2; boards 03, 04 and 07). Its
 * words come from the API (VAY-2524), written by vayada from the stored change, never by the model.
 * Only its Yes button makes the change; after the answer the card changes in place.
 */

/** A change being made is read again this often (then less often), and a failed read after RETRY_MS. */
export const CHANGE_POLL_MS = 2_000;
const SLOW_POLL_MS = 10_000;
const FAST_POLLS = 15;
const RETRY_MS = 10_000;
/** Longest wait for a change's expiry: a change waits 15 minutes at most. */
const MAX_WAIT_MS = 15 * 60_000;

/** undefined: loading; null: there is no card to show (changes off, or it can't be read). */
export type CardStatus = PendingActionView | null | undefined;

export function timeOf(value: string | null, locale: string): string {
  if (!value || Number.isNaN(Date.parse(value))) return "";
  return new Intl.DateTimeFormat(dateLocale(locale), { hour: "2-digit", minute: "2-digit" }).format(
    new Date(value),
  );
}

/** "Block room 12 for 3 nights?" → "Block room 12 for 3 nights": the bar's and outcomes' title. */
export const changeTitle = (view: PendingActionView): string =>
  toPlainText(view.card?.question ?? "").replace(/\?$/, "");

/** When to read a change again: while it is made, and once a waiting one has expired. */
export function nextReadIn(view: PendingActionView, polls: number, now = Date.now()) {
  if (view.state === "running") return polls < FAST_POLLS ? CHANGE_POLL_MS : SLOW_POLL_MS;
  if (view.state !== "needs_answer" || !view.answerBy) return undefined;
  const due = Date.parse(view.answerBy) - now + 1_000;
  if (Number.isNaN(due)) return undefined;
  return Math.min(Math.max(due, CHANGE_POLL_MS), MAX_WAIT_MS);
}

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
  /** Asks the turn's question again (expired, changed); absent when it can't be asked here. */
  onAskAgain?: () => void;
}) {
  const [view, setView] = useState<CardStatus>(undefined);
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** After an answer that didn't come back: "not_sent" (it still waits) or "unknown". */
  const [answerProblem, setAnswerProblem] = useState<"not_sent" | "unknown" | null>(null);
  // Every read and answer takes a number; an older one that comes back later is dropped.
  const latest = useRef(0);
  const polls = useRef(0);
  const frame = useRef<HTMLDivElement>(null);
  const answered = useRef(false);

  const read = useCallback(async (): Promise<CardStatus | "failed"> => {
    const mine = ++latest.current;
    try {
      const next = (await api.pendingAction(id)) ?? null;
      if (mine !== latest.current) return undefined;
      setView((current) => (next === null && current ? current : next));
      setReadFailed(false);
      return next;
    } catch {
      if (mine !== latest.current) return undefined;
      // Keep what is shown; read again shortly.
      setView((current) => current ?? null);
      setReadFailed(true);
      return "failed";
    }
  }, [api, id]);

  useEffect(() => {
    void read();
  }, [read]);

  useEffect(() => {
    onView(id, view);
  }, [id, view, onView]);
  useEffect(() => () => onView(id, undefined), [id, onView]);

  useEffect(() => {
    const delay = readFailed ? RETRY_MS : view ? nextReadIn(view, polls.current) : undefined;
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      polls.current += 1;
      void read();
    }, delay);
    return () => clearTimeout(timer);
  }, [view, readFailed, read]);

  // After the answer, the card's new state takes the focus (the button that had it is gone).
  useEffect(() => {
    if (answered.current && view && view.state !== "needs_answer") {
      answered.current = false;
      frame.current?.focus();
    }
  }, [view]);

  const answer = async (given: "yes" | "no") => {
    if (!view || busy) return;
    const mine = ++latest.current;
    setBusy(true);
    setAnswerProblem(null);
    try {
      const next = await api.answer(view, given);
      if (mine !== latest.current) return;
      answered.current = true;
      polls.current = 0;
      setView(next);
    } catch {
      if (mine !== latest.current) return;
      // The answer may have arrived and even run before the reply was lost: say only what a fresh
      // read shows.
      const now = await read();
      if (now === "failed" || now === undefined || now === null) setAnswerProblem("unknown");
      else if (now.state === "needs_answer") setAnswerProblem("not_sent");
      else answered.current = true;
    } finally {
      setBusy(false);
    }
  };

  if (view === undefined) return <Quiet text={m.loading} />;
  if (view === null) return <Quiet text={m.unavailable} />;

  const card = view.card;
  if (view.state === "needs_answer" || view.state === "running") {
    const running = view.state === "running";
    return (
      <section
        id={`change-${view.id}`}
        aria-label={m.needsAnswer}
        className="overflow-hidden rounded-xl border-2 border-primary-600 bg-white"
      >
        <div className="flex items-center justify-between gap-2 bg-primary-50 px-3.5 py-2 text-[13px] font-semibold text-primary-700">
          <span className="flex items-center gap-1.5">
            <ShieldCheckIcon className="h-4 w-4" aria-hidden="true" />
            {running ? m.running : m.needsAnswer}
          </span>
          {!running && view.answerBy && (
            <span className="text-xs font-medium">
              {fill(m.answerBy, { time: timeOf(view.answerBy, locale) })}
            </span>
          )}
        </div>
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
                        {toPlainText(detail.label)}
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
              {/* Only while it waits and vayada could write the card: the Yes is bound to it. */}
              {!running && view.cardSha256 && (
                <div className="mt-3.5 flex gap-2">
                  {/* aria-disabled, not disabled: the focus stays on the button while it sends. */}
                  <button
                    type="button"
                    aria-disabled={busy}
                    onClick={() => void answer("no")}
                    className="inline-flex h-9 items-center rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 aria-disabled:opacity-60"
                  >
                    {m.no}
                  </button>
                  <button
                    type="button"
                    aria-disabled={busy}
                    onClick={() => void answer("yes")}
                    className="inline-flex h-9 flex-1 items-center justify-center rounded-md bg-primary-600 px-4 text-sm font-semibold text-white hover:bg-primary-700 aria-disabled:opacity-60"
                  >
                    {toPlainText(card.yesLabel)}
                  </button>
                </div>
              )}
              {answerProblem && (
                <p className="mt-2 text-[13px] text-red-700" role="alert">
                  {answerProblem === "not_sent" ? m.answerFailed : m.answerUnknown}
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

  const outcome = OUTCOMES[view.state as keyof typeof OUTCOMES] as Outcome | undefined;
  // A state this panel doesn't know yet (a later API): say only that it can't be shown.
  if (!outcome) return <Quiet text={m.unavailable} />;
  const at = timeOf(outcome.time === "answered" ? view.answeredAt : view.finishedAt, locale);
  return (
    <section
      id={`change-${view.id}`}
      aria-label={m[outcome.label]}
      className={`overflow-hidden rounded-xl border ${outcome.frame}`}
    >
      <div
        ref={frame}
        tabIndex={-1}
        role="status"
        className={`flex items-center justify-between gap-2 px-3.5 py-2 text-[13px] font-semibold outline-none ${outcome.head}`}
      >
        <span className="flex items-center gap-1.5">
          {outcome.icon}
          {m[outcome.label]}
        </span>
        {outcome.time && at && <span className="text-xs font-medium">{at}</span>}
      </div>
      <div className="bg-white px-3.5 pb-3 pt-2.5">
        {card && (
          <h4 className="text-[15px] font-semibold text-gray-900">
            {view.state === "done" ? toPlainText(card.doneTitle) : changeTitle(view)}
          </h4>
        )}
        <p className="mt-1 text-sm text-gray-600">{fill(m[outcome.body], { time: at })}</p>
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

function Quiet({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-gray-200 px-4 py-3 text-[13px] text-gray-500">
      {text}
    </div>
  );
}

type Outcome = {
  label: keyof ChangeMessages;
  body: keyof ChangeMessages;
  icon: ReactNode;
  frame: string;
  head: string;
  /** The time in the header: when the person answered, or when it ended. */
  time?: "answered" | "finished";
  askAgain?: boolean;
};

const GREY = { frame: "border-gray-200", head: "bg-gray-50 text-gray-700" };
const icon = (Icon: typeof CheckIcon) => <Icon className="h-4 w-4" aria-hidden="true" />;

const OUTCOMES: Record<Exclude<PendingActionState, "needs_answer" | "running">, Outcome> = {
  done: {
    label: "done",
    body: "doneBody",
    icon: icon(CheckIcon),
    frame: "border-green-200",
    head: "bg-green-50 text-green-700",
    time: "answered",
  },
  declined: {
    label: "declined",
    body: "declinedBody",
    icon: icon(XMarkIcon),
    ...GREY,
    time: "answered",
  },
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
    time: "finished",
    askAgain: true,
  },
  not_allowed: {
    label: "notAllowed",
    body: "notAllowedBody",
    icon: icon(LockClosedIcon),
    ...GREY,
    time: "finished",
  },
  stopped: { label: "stopped", body: "stoppedBody", icon: icon(NoSymbolIcon), ...GREY },
  failed: {
    label: "failed",
    body: "failedBody",
    icon: icon(ExclamationTriangleIcon),
    frame: "border-red-200",
    head: "bg-red-50 text-red-700",
    time: "finished",
  },
  unsure: {
    label: "unsure",
    body: "unsureBody",
    icon: icon(QuestionMarkCircleIcon),
    frame: "border-amber-200",
    head: "bg-amber-50 text-amber-800",
    time: "finished",
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
      {/* The title gives way first: "until 09:58" always shows. */}
      <span className="flex min-w-0 flex-1 gap-1 whitespace-nowrap">
        <span className="shrink-0 font-semibold">{m.waiting}</span>
        <span className="min-w-0 truncate">{changeTitle(view)}</span>
        {view.answerBy && (
          <span className="shrink-0">
            · {fill(m.until, { time: timeOf(view.answerBy, locale) })}
          </span>
        )}
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
