"use client";

import {
  ArrowRightIcon,
  CalendarDaysIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  CreditCardIcon,
  DocumentTextIcon,
  PaintBrushIcon,
  PhotoIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import {
  HOTEL_SETUP_CHECKLIST_SETUP_STEPS,
  type HotelSetupChecklist,
  type HotelSetupChecklistAcknowledgeable,
  type HotelSetupChecklistItemId,
} from "@vayada/domain-hotels";
import { useEffect, useState, type ComponentType, type SVGProps } from "react";

import {
  HOTEL_SETUP_CHECKLIST_MESSAGES,
  type HotelSetupChecklistMessages,
} from "./hotelSetupChecklistMessages";

export type HotelSetupChecklistCardProps = {
  checklist: HotelSetupChecklist;
  hotelName: string;
  product: "pms" | "booking_admin";
  /** For the calendar row ("all 8 rooms bookable"); null when the dashboard doesn't know. */
  roomCount?: number | null;
  /** Before going live: back into the setup screens. */
  onContinueSetup: () => void;
  /** An item's page: photos, style, online cards, and Review for calendar and guest terms. */
  onOpen: (item: HotelSetupChecklistItemId) => void;
  /** "Looks good"; resolves with the checklist after it. */
  onLooksGood: (item: HotelSetupChecklistAcknowledgeable) => Promise<unknown>;
  /** Hide for now, or Dismiss once everything is done; for the signed-in person only. */
  onHide: () => Promise<unknown>;
  onDismiss: () => Promise<unknown>;
  messages?: HotelSetupChecklistMessages;
};

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const ICONS: Partial<Record<HotelSetupChecklistItemId, Icon>> = {
  photos: PhotoIcon,
  style: PaintBrushIcon,
  calendar: CalendarDaysIcon,
  guest_terms: DocumentTextIcon,
  online_cards: CreditCardIcon,
};
const ACKNOWLEDGEABLE: readonly HotelSetupChecklistItemId[] = ["calendar", "guest_terms"];
const SETUP_ITEMS: readonly HotelSetupChecklistItemId[] = [
  "hotel_basics",
  "first_room",
  "guest_payment",
  "booking_published",
];

const CARD = "rounded-2xl border border-gray-200 bg-white p-5 lg:p-8";
const OUTLINE =
  "inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-gray-300 bg-white px-5 text-[15px] font-semibold text-gray-950 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:opacity-50";
const TEXT_BUTTON =
  "shrink-0 rounded text-sm font-semibold text-gray-600 outline-none hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-primary-600";

function Progress({ done, total, className }: { done: number; total: number; className: string }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      className={`h-1.5 overflow-hidden rounded-full bg-primary-100 ${className}`}
    >
      <div
        className="h-full rounded-full bg-primary-600"
        style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }}
      />
    </div>
  );
}

function DoneMark({ size }: { size: "h-5 w-5" | "h-6 w-6" }) {
  return (
    <span
      aria-hidden="true"
      className={`flex ${size} shrink-0 items-center justify-center rounded-full bg-green-600 text-white`}
    >
      <CheckIcon className="h-3.5 w-3.5" />
    </span>
  );
}

const PRIMARY =
  "inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-primary-600 px-5 text-base font-semibold text-white outline-none hover:bg-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2";

/** Before the booking page is published: how far the five setup screens are (Paper rev 4 c01-0). */
function SetupProgress({
  checklist,
  messages,
  onContinueSetup,
}: Pick<HotelSetupChecklistCardProps, "checklist" | "onContinueSetup"> & {
  messages: HotelSetupChecklistMessages;
}) {
  const { done, total, next } = checklist.setup;
  return (
    <section aria-labelledby="hotel-setup-checklist-title" className={CARD}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 id="hotel-setup-checklist-title" className="text-xl font-semibold text-gray-950">
            {messages.setupTitle}
          </h2>
          <p className="mt-1 text-[15px] text-gray-600">{messages.setupSubtitle(done, total)}</p>
        </div>
        <button
          type="button"
          onClick={onContinueSetup}
          className={`${PRIMARY} hidden lg:inline-flex`}
        >
          {messages.continueSetup}
          <ArrowRightIcon className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
      <Progress done={done} total={total} className="mt-6 w-full" />
      <ol className="mt-5 flex flex-col gap-3">
        {HOTEL_SETUP_CHECKLIST_SETUP_STEPS.map((step, index) => {
          const isDone = index < done;
          const isNext = step === next;
          return (
            <li key={step} className="flex items-center gap-3 text-[15px]">
              {isDone ? (
                <DoneMark size="h-6 w-6" />
              ) : (
                <span
                  aria-hidden="true"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-600"
                >
                  {index + 1}
                </span>
              )}
              <span
                className={
                  isDone ? "text-gray-600" : isNext ? "font-medium text-gray-950" : "text-gray-800"
                }
              >
                {messages.setupSteps[step]}
              </span>
              {isNext ? (
                <span className="rounded-full bg-primary-50 px-2.5 py-0.5 text-xs font-semibold text-primary-700">
                  {messages.next}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {/* Phones: the button under the steps (c01-0m). */}
      <button
        type="button"
        onClick={onContinueSetup}
        className={`${PRIMARY} mt-5 w-full lg:hidden`}
      >
        {messages.continueSetup}
        <ArrowRightIcon className="h-5 w-5" aria-hidden="true" />
      </button>
    </section>
  );
}

const STATE_CHIP: Record<string, string> = {
  todo: "bg-primary-50 text-primary-700",
  default_in_use: "bg-gray-100 text-gray-700",
  later: "bg-amber-50 text-amber-700",
};

function StateChip({ state, label }: { state: string; label: string }) {
  if (!label) return null;
  return (
    <span
      className={`mt-1.5 inline-block rounded-md px-2 py-0.5 text-xs font-semibold lg:mt-0 ${STATE_CHIP[state] ?? ""}`}
    >
      {label}
    </span>
  );
}

function ItemIcon({ icon: Icon }: { icon: Icon }) {
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-gray-700">
      <Icon className="h-5 w-5" aria-hidden="true" />
    </span>
  );
}

/**
 * VAY-2247 wave 2: the setup checklist card both dashboards show (Paper rev 4 c01, c02). Before going live
 * it follows the setup screens; after, the items still open, with what setup already did as chips; once
 * everything is done, "Setup complete" with Dismiss. Hidden or dismissed, it shows nothing (the header
 * shows HotelSetupChecklistChip instead while hidden).
 */
export function HotelSetupChecklistCard({
  checklist,
  hotelName,
  product,
  roomCount = null,
  onContinueSetup,
  onOpen,
  onLooksGood,
  onHide,
  onDismiss,
  messages = HOTEL_SETUP_CHECKLIST_MESSAGES,
}: HotelSetupChecklistCardProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function run(key: string, action: () => Promise<unknown>, confirmed?: string) {
    if (busy) return;
    setBusy(key);
    try {
      await action();
      if (confirmed) setNotice({ tone: "ok", text: confirmed });
    } catch {
      setNotice({ tone: "error", text: messages.failed });
    } finally {
      setBusy(null);
    }
  }

  const toast = notice ? (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      className="fixed right-4 top-4 z-50 flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-[15px] font-medium text-gray-950 shadow-lg lg:right-6 lg:top-[72px]"
    >
      {notice.tone === "ok" ? (
        <CheckCircleIcon className="h-5 w-5 text-green-600" aria-hidden="true" />
      ) : null}
      {notice.text}
      <button
        type="button"
        onClick={() => setNotice(null)}
        aria-label={messages.dismiss}
        className="ml-2 rounded text-gray-400 outline-none hover:text-gray-600 focus-visible:ring-2 focus-visible:ring-primary-600"
      >
        <XMarkIcon className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  ) : null;

  if (checklist.viewer.dismissed) return toast;
  if (checklist.phase === "setup") {
    return (
      <SetupProgress checklist={checklist} messages={messages} onContinueSetup={onContinueSetup} />
    );
  }
  if (checklist.phase === "complete") {
    return (
      <section
        aria-labelledby="hotel-setup-checklist-title"
        className="flex items-start gap-4 rounded-2xl border border-green-200 bg-white p-5 lg:p-6"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-green-50 text-green-700">
          <CheckCircleIcon className="h-6 w-6" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="hotel-setup-checklist-title" className="text-lg font-semibold text-gray-950">
            {messages.completeTitle}
          </h2>
          <p className="mt-0.5 text-[15px] text-gray-600">{messages.completeSubtitle}</p>
        </div>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void run("dismiss", onDismiss)}
          className={TEXT_BUTTON}
        >
          {messages.dismiss}
        </button>
        {toast}
      </section>
    );
  }
  if (checklist.viewer.hidden) return toast;

  const looksGood = (item: HotelSetupChecklistItemId) =>
    void run(
      item,
      () => onLooksGood(item as HotelSetupChecklistAcknowledgeable),
      messages.confirmed[item],
    );

  const doneItems = checklist.items.filter((item) => item.state === "done");
  const open = checklist.items.filter(
    (item) => item.state !== "done" && !SETUP_ITEMS.includes(item.id),
  );
  return (
    <section aria-labelledby="hotel-setup-checklist-title" className={CARD}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h2 id="hotel-setup-checklist-title" className="text-xl font-semibold text-gray-950">
            {messages.liveTitle(hotelName)}
          </h2>
          <p className="mt-1 text-[15px] text-gray-600">{messages.liveSubtitle[product]}</p>
        </div>
        <div className="hidden shrink-0 items-start gap-6 lg:flex">
          <div className="flex w-40 flex-col items-end gap-2">
            <p className="text-[15px] font-semibold text-gray-950">
              {messages.doneCount(checklist.done, checklist.total)}
            </p>
            <Progress done={checklist.done} total={checklist.total} className="w-full" />
          </div>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run("hide", onHide)}
            className={TEXT_BUTTON}
          >
            {messages.hideForNow}
          </button>
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-2 lg:hidden">
        <p className="text-[15px] font-semibold text-gray-950">
          {messages.doneCount(checklist.done, checklist.total)}
        </p>
        <Progress done={checklist.done} total={checklist.total} className="w-full" />
      </div>
      {doneItems.length ? (
        <ul
          className="mt-5 flex flex-wrap gap-x-5 gap-y-2"
          aria-label={messages.doneCount(checklist.done, checklist.total)}
        >
          {doneItems.map((item) => (
            <li key={item.id} className="flex items-center gap-2 text-[15px] text-gray-800">
              <DoneMark size="h-5 w-5" />
              {messages.items[item.id].name}
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="mt-5 divide-y divide-gray-200 border-t border-gray-200">
        {open.map((item) => {
          const Icon = ICONS[item.id] ?? DocumentTextIcon;
          const copy = messages.items[item.id];
          const state = item.state === "done" ? "" : messages.states[item.state];
          const acknowledgeable = ACKNOWLEDGEABLE.includes(item.id);
          return (
            <li key={item.id}>
              {/* Phones (c01-1m): the title and its state; the row opens the item, or Looks good / Review. */}
              <div className="py-4 lg:hidden">
                {acknowledgeable && item.state === "default_in_use" ? (
                  <div className="flex items-start gap-4">
                    <ItemIcon icon={Icon} />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-[15px] font-semibold text-gray-950">{copy.title}</h3>
                      <StateChip state={item.state} label={state} />
                      <div className="mt-3 flex items-center gap-4">
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => looksGood(item.id)}
                          className={OUTLINE}
                        >
                          {messages.looksGood}
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpen(item.id)}
                          className="rounded text-[15px] font-semibold text-primary-600 outline-none hover:text-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600"
                        >
                          {messages.review}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => onOpen(item.id)}
                    className="flex w-full items-start gap-4 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-600"
                  >
                    <ItemIcon icon={Icon} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-semibold text-gray-950">
                        {copy.title}
                      </span>
                      <StateChip state={item.state} label={state} />
                    </span>
                    <ChevronRightIcon
                      className="mt-1 h-5 w-5 shrink-0 text-gray-400"
                      aria-hidden="true"
                    />
                  </button>
                )}
              </div>
              <div className="hidden items-center gap-6 py-5 lg:flex">
                <div className="flex min-w-0 flex-1 items-start gap-4">
                  <ItemIcon icon={Icon} />
                  <div className="min-w-0 max-w-[480px]">
                    <h3 className="text-[15px] font-semibold text-gray-950">{copy.title}</h3>
                    <p className="mt-0.5 text-sm leading-5 text-gray-600">
                      {copy.description({ roomCount })}
                    </p>
                  </div>
                </div>
                <div className="flex w-[480px] items-center justify-between gap-4">
                  <StateChip state={item.state} label={state} />
                  <div className="ml-auto flex items-center gap-6">
                    {acknowledgeable && item.state === "default_in_use" ? (
                      <>
                        <button
                          type="button"
                          disabled={busy !== null}
                          aria-busy={busy === item.id || undefined}
                          onClick={() => looksGood(item.id)}
                          className={OUTLINE}
                        >
                          <CheckIcon className="h-4 w-4" aria-hidden="true" />
                          {messages.looksGood}
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpen(item.id)}
                          className={TEXT_BUTTON}
                        >
                          {messages.review}
                        </button>
                      </>
                    ) : (
                      <button type="button" onClick={() => onOpen(item.id)} className={OUTLINE}>
                        {messages.actions[item.id] ?? messages.review}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => void run("hide", onHide)}
        className={`${TEXT_BUTTON} mt-2 lg:hidden`}
      >
        {messages.hideForNow}
      </button>
      {toast}
    </section>
  );
}

/** The header pill while the checklist is hidden ("Setup 4 of 9", c01-3); it shows the card again. */
export function HotelSetupChecklistChip({
  checklist,
  onShow,
  messages = HOTEL_SETUP_CHECKLIST_MESSAGES,
}: {
  checklist: HotelSetupChecklist;
  onShow: () => void;
  messages?: HotelSetupChecklistMessages;
}) {
  if (checklist.phase !== "live" || !checklist.viewer.hidden || checklist.viewer.dismissed)
    return null;
  return (
    <button
      type="button"
      onClick={onShow}
      className="inline-flex h-8 items-center gap-2.5 rounded-full border border-gray-200 bg-white px-3 text-[13px] font-semibold text-gray-800 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-primary-600"
    >
      <Progress done={checklist.done} total={checklist.total} className="w-12" />
      {messages.chip(checklist.done, checklist.total)}
    </button>
  );
}
