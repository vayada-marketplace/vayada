"use client";

import { CheckIcon, LockClosedIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type {
  HotelGoLiveChecklist,
  HotelGoLiveItemId,
  HotelGoLiveSetupStep,
} from "@vayada/domain-hotels";

/**
 * VAY-2451: the four-step setup's dashboard cards (Timo's mockup, approved by Flamur in place of Paper),
 * shared by Booking Admin and the PMS. English by default; the dashboards may pass their own words.
 */
export type GoLiveChecklistMessages = {
  setupTitle: (hotel: string) => string;
  setupNext: (step: string, minutes: number) => string;
  continueSetup: string;
  steps: Record<HotelGoLiveSetupStep, { label: string; minutes: number }>;
  stepDone: string;
  stepNext: (minutes: number) => string;
  stepTime: (minutes: number) => string;
  goLiveTitle: string;
  liveTitle: string;
  goLiveSubtitle: string;
  liveSubtitle: string;
  doneCount: (done: number, total: number) => string;
  required: string;
  recommended: string;
  edit: string;
  items: Record<
    Exclude<HotelGoLiveItemId, "booking_published">,
    {
      title: string;
      doneTitle?: string;
      description: string;
      /** In place of the description once done (e.g. the rules aren't the defaults any more). */
      doneDescription?: string;
      action: string;
    }
  >;
  roomTypesDone: (room: {
    name: string;
    rooms: number;
    maxGuests: number;
    photos: number;
  }) => string;
  ratesPlaceholder: string;
  /** Under room types, done without a photo: a suggestion, tagged Recommended (VAY-2451). */
  roomPhotosMissing: string;
  publishTitle: string;
  publishLocked: string;
  publishReady: string;
  publishLive: string;
  publish: string;
  live: string;
  laterTitle: string;
  onlineCardsTitle: string;
  onlineCardsDescription: string;
  connect: string;
  channelManagerTitle: string;
  channelManagerDescription: string;
  soon: string;
  toast: string;
  dismiss: string;
};

const plural = (count: number, word: string) => `${count} ${count === 1 ? word : `${word}s`}`;

export const GO_LIVE_CHECKLIST_MESSAGES: GoLiveChecklistMessages = {
  setupTitle: (hotel) => `Finish setting up ${hotel}`,
  setupNext: (step, minutes) =>
    `Next: ${step}, about ${plural(minutes, "minute")}. Everything so far is saved.`,
  continueSetup: "Continue setup",
  steps: {
    property: { label: "Your property", minutes: 1 },
    location: { label: "Location & contact", minutes: 2 },
    room: { label: "First room", minutes: 5 },
    payments: { label: "Guest payments", minutes: 1 },
  },
  stepDone: "Done",
  stepNext: (minutes) => `Next · ${minutes} min`,
  stepTime: (minutes) => `${minutes} min`,
  goLiveTitle: "Get ready to go live",
  liveTitle: "Your booking page is live",
  goLiveSubtitle:
    "Your booking page goes live when you publish. Rooms and rates are the only must-haves.",
  liveSubtitle: "Share your link and start taking direct bookings.",
  doneCount: (done, total) => `${done} of ${total} done`,
  required: "Required",
  recommended: "Recommended",
  edit: "Edit",
  items: {
    property_details: {
      title: "Property details",
      description: "Name, type, address and contacts",
      action: "Edit",
    },
    room_types: {
      title: "Add your room types",
      doneTitle: "Room types",
      description: "Name, size, beds, guests and at least one photo",
      action: "Add rooms",
    },
    rates: {
      title: "Set your rates",
      description: "A nightly price for each room type. Guests can't book without one.",
      action: "Add rates",
    },
    booking_rules: {
      title: "Review booking rules",
      description:
        "Defaults set: free cancellation until 3 days before · check-in 15:00, check-out 11:00",
      doneDescription: "Cancellation, check-in times and guest rules",
      action: "Review",
    },
    property_photos: {
      title: "Add property photos",
      description: "The main photos at the top of your booking page",
      action: "Upload",
    },
  },
  roomTypesDone: (room) =>
    `${room.name} · ${plural(room.rooms, "room")} · up to ${room.maxGuests} guests · ${plural(room.photos, "photo")}`,
  ratesPlaceholder: "Your room shows a placeholder price. Set real prices before you go live.",
  roomPhotosMissing: "Add a photo to each room type. Guests book rooms they can see.",
  publishTitle: "Publish your booking page",
  publishLocked: "Available once your room types and rates are in",
  publishReady: "All set. Guests can book as soon as you publish.",
  publishLive: "Guests can book on your booking page.",
  publish: "Publish",
  live: "Live",
  laterTitle: "Later, when you're ready",
  onlineCardsTitle: "Online card payments",
  onlineCardsDescription: "Guests pay when they book",
  connect: "Connect",
  channelManagerTitle: "Channel manager",
  channelManagerDescription: "Sync Booking.com and Airbnb",
  soon: "Soon",
  toast: "Setup complete. A few steps left before you go live.",
  dismiss: "Dismiss",
};

const STEP_ORDER: readonly HotelGoLiveSetupStep[] = ["property", "location", "room", "payments"];

/**
 * A setup step as the setup links name it (?step=): the room step is the setup's older "rooms", the one id
 * the PMS's /setup link keeps (buildSharedHotelSetupRedirectPath drops unknown steps).
 */
export function goLiveSetupStepParam(step: HotelGoLiveSetupStep): string {
  return step === "room" ? "rooms" : step;
}

const PRIMARY =
  "inline-flex h-10 shrink-0 items-center justify-center rounded-[10px] bg-primary-600 px-4 text-sm font-semibold text-white outline-none hover:bg-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2";
const SECONDARY =
  "inline-flex h-10 shrink-0 items-center justify-center rounded-[10px] border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-700 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2";

/** State A: setup isn't finished. A ring with steps done, what comes next, and the four steps as tiles. */
export function GoLiveSetupCard({
  checklist,
  hotelName,
  onContinue,
  onOpenStep,
  messages = GO_LIVE_CHECKLIST_MESSAGES,
}: {
  checklist: HotelGoLiveChecklist;
  hotelName: string;
  onContinue: () => void;
  /** A done step, opened to change it. */
  onOpenStep: (step: HotelGoLiveSetupStep) => void;
  messages?: GoLiveChecklistMessages;
}) {
  const { done, total, next } = checklist.setup;
  const nextStep = next ?? "payments";
  const circumference = 138.2;
  return (
    <section
      aria-label={messages.setupTitle(hotelName)}
      className="rounded-2xl border border-gray-200 bg-white p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative h-14 w-14 shrink-0" aria-hidden="true">
          <svg viewBox="0 0 50 50" className="h-14 w-14 -rotate-90">
            <circle
              cx="25"
              cy="25"
              r="22"
              fill="none"
              strokeWidth="5"
              className="stroke-primary-100"
            />
            <circle
              cx="25"
              cy="25"
              r="22"
              fill="none"
              strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray={`${((done / total) * circumference).toFixed(1)} ${circumference}`}
              className="stroke-primary-600"
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-gray-950">
            {`${done}/${total}`}
          </span>
        </div>
        <div className="min-w-0 flex-[1_1_180px] sm:flex-[1_1_320px]">
          <h2 className="text-lg font-semibold text-gray-950">{messages.setupTitle(hotelName)}</h2>
          <p className="mt-1 text-sm text-gray-600">
            {messages.setupNext(messages.steps[nextStep].label, messages.steps[nextStep].minutes)}
          </p>
        </div>
        <button type="button" onClick={onContinue} className={`${PRIMARY} w-full sm:w-auto`}>
          {messages.continueSetup}
        </button>
      </div>
      <ol className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {STEP_ORDER.map((step, index) => {
          const stepDone = index < done;
          const isNext = step === next;
          const locked = !stepDone && !isNext;
          const { label, minutes } = messages.steps[step];
          return (
            <li key={step}>
              <button
                type="button"
                disabled={locked}
                onClick={() => (isNext ? onContinue() : onOpenStep(step))}
                className={`flex w-full items-start gap-2.5 rounded-xl border p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-600 disabled:cursor-default ${
                  isNext
                    ? "border-primary-600 bg-primary-50"
                    : stepDone
                      ? "border-gray-200 bg-white hover:bg-gray-50"
                      : "border-gray-200 bg-gray-50"
                }`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                    stepDone
                      ? "bg-green-500 text-white"
                      : isNext
                        ? "bg-primary-600 text-white"
                        : "border-[1.5px] border-gray-300 bg-white text-gray-500"
                  }`}
                >
                  {stepDone ? (
                    // The line under the step says Done.
                    <CheckIcon className="h-3.5 w-3.5 stroke-[3]" aria-hidden="true" />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold leading-5 text-gray-950">
                    {label}
                  </span>
                  <span
                    className={`block text-xs ${
                      stepDone ? "text-green-700" : isNext ? "text-primary-700" : "text-gray-500"
                    }`}
                  >
                    {stepDone
                      ? messages.stepDone
                      : isNext
                        ? messages.stepNext(minutes)
                        : messages.stepTime(minutes)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * State B: setup is finished. Six rows, the first open one with the filled button; Publish last. Once live,
 * the card can be dismissed (the dashboards stop showing it).
 */
export function GoLiveChecklistCard({
  checklist,
  onOpenItem,
  onPublish,
  onDismiss,
  messages = GO_LIVE_CHECKLIST_MESSAGES,
}: {
  checklist: HotelGoLiveChecklist;
  onOpenItem: (item: Exclude<HotelGoLiveItemId, "booking_published">) => void;
  onPublish: () => void;
  onDismiss?: (() => void) | null;
  messages?: GoLiveChecklistMessages;
}) {
  const live = checklist.phase === "live";
  const state = new Map(checklist.items.map((item) => [item.id, item.state]));
  const rows = (
    ["property_details", "room_types", "rates", "booking_rules", "property_photos"] as const
  ).map((id) => ({ id, done: state.get(id) === "done" }));
  const firstOpen = rows.find((row) => !row.done)?.id ?? null;
  return (
    <section
      aria-label={live ? messages.liveTitle : messages.goLiveTitle}
      className="rounded-2xl border border-gray-200 bg-white p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-gray-950">
          {live ? messages.liveTitle : messages.goLiveTitle}
        </h2>
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-gray-600">
            {messages.doneCount(checklist.done, checklist.total)}
          </p>
          {live && onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              aria-label={messages.dismiss}
              className="rounded p-1 text-gray-400 outline-none hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-primary-600"
            >
              <XMarkIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
      <p className="mt-1 text-sm text-gray-600">
        {live ? messages.liveSubtitle : messages.goLiveSubtitle}
      </p>
      <div
        className="mt-3 flex gap-1"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={checklist.total}
        aria-valuenow={checklist.done}
        aria-label={messages.doneCount(checklist.done, checklist.total)}
      >
        {Array.from({ length: checklist.total }, (_, index) => (
          <span
            key={index}
            aria-hidden="true"
            className={`h-1.5 flex-1 rounded-full ${
              index < checklist.done ? (live ? "bg-green-500" : "bg-primary-600") : "bg-gray-200"
            }`}
          />
        ))}
      </div>
      <ul className="mt-4 divide-y divide-gray-100">
        {rows.map(({ id, done }) => {
          const words = messages.items[id];
          // Room types count once they have rooms; a room type without a photo only gets a suggestion.
          const photoHint = id === "room_types" && done && checklist.roomPhotosMissing;
          const tag = photoHint
            ? messages.recommended
            : done
              ? null
              : id === "room_types" || id === "rates"
                ? messages.required
                : id === "property_photos"
                  ? messages.recommended
                  : null;
          const description = photoHint
            ? messages.roomPhotosMissing
            : id === "room_types" && done && checklist.firstRoomType
              ? messages.roomTypesDone(checklist.firstRoomType)
              : id === "rates" && !done && checklist.placeholderPrices
                ? messages.ratesPlaceholder
                : done && words.doneDescription
                  ? words.doneDescription
                  : words.description;
          return (
            <li key={id} className="flex items-center gap-3 py-3">
              <span
                className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                  done
                    ? "bg-green-500 text-white"
                    : id === firstOpen
                      ? "border-2 border-primary-600 bg-white"
                      : "border-[1.5px] border-gray-300 bg-white"
                }`}
              >
                {done ? (
                  <>
                    <CheckIcon className="h-3.5 w-3.5 stroke-[3]" aria-hidden="true" />
                    <span className="sr-only">{`${messages.stepDone}:`}</span>
                  </>
                ) : null}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span
                    className={`text-sm font-semibold ${done ? "text-gray-600" : "text-gray-950"}`}
                  >
                    {done && words.doneTitle ? words.doneTitle : words.title}
                  </span>
                  {tag ? (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        tag === messages.required
                          ? "bg-red-50 text-red-700"
                          : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {tag}
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-[13px] text-gray-500">{description}</p>
              </div>
              <button
                type="button"
                onClick={() => onOpenItem(id)}
                className={!done && id === firstOpen ? PRIMARY : SECONDARY}
              >
                {done ? messages.edit : words.action}
              </button>
            </li>
          );
        })}
        <li className="flex items-center gap-3 py-3">
          <span
            aria-hidden="true"
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
              live ? "bg-green-50 text-green-700" : "bg-primary-50 text-primary-600"
            }`}
          >
            {live ? (
              <CheckIcon className="h-3.5 w-3.5 stroke-[3]" />
            ) : (
              <LockClosedIcon className="h-3.5 w-3.5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-gray-950">{messages.publishTitle}</p>
            <p className="mt-0.5 text-[13px] text-gray-500">
              {live
                ? messages.publishLive
                : checklist.canPublish
                  ? messages.publishReady
                  : messages.publishLocked}
            </p>
          </div>
          {live ? (
            <span className="rounded-full bg-green-50 px-2.5 py-1 text-xs font-semibold text-green-700">
              {messages.live}
            </span>
          ) : (
            <button
              type="button"
              disabled={!checklist.canPublish}
              onClick={onPublish}
              className={`${PRIMARY} disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-500`}
            >
              {messages.publish}
            </button>
          )}
        </li>
      </ul>
    </section>
  );
}

/** "Later, when you're ready": online card payments and the channel manager (not open yet). */
export function GoLiveLaterCard({
  checklist,
  onConnectCards,
  messages = GO_LIVE_CHECKLIST_MESSAGES,
}: {
  checklist: HotelGoLiveChecklist;
  onConnectCards: () => void;
  messages?: GoLiveChecklistMessages;
}) {
  const cards = checklist.later.find((item) => item.id === "online_cards")?.state ?? "later";
  return (
    <section
      aria-label={messages.laterTitle}
      className="rounded-2xl border border-gray-200 bg-white p-4 sm:p-5"
    >
      <h2 className="text-sm font-semibold text-gray-950">{messages.laterTitle}</h2>
      <ul className="mt-3 flex flex-col gap-3">
        <li className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-950">{messages.onlineCardsTitle}</p>
            <p className="text-[13px] text-gray-500">{messages.onlineCardsDescription}</p>
          </div>
          {cards === "done" ? (
            <span className="relative">
              <CheckIcon className="h-5 w-5 text-green-600" aria-hidden="true" />
              <span className="sr-only">{messages.stepDone}</span>
            </span>
          ) : (
            <button type="button" onClick={onConnectCards} className={SECONDARY}>
              {messages.connect}
            </button>
          )}
        </li>
        <li className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-950">{messages.channelManagerTitle}</p>
            <p className="text-[13px] text-gray-500">{messages.channelManagerDescription}</p>
          </div>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
            {messages.soon}
          </span>
        </li>
      </ul>
    </section>
  );
}

/** After Finish setup: "Setup complete. A few steps left before you go live." */
export function SetupFinishedToast({
  onDismiss,
  messages = GO_LIVE_CHECKLIST_MESSAGES,
}: {
  onDismiss: () => void;
  messages?: GoLiveChecklistMessages;
}) {
  return (
    <div
      role="status"
      className="fixed left-3 right-3 top-[68px] z-40 flex items-center gap-3 rounded-xl bg-gray-950 px-4 py-3 text-sm font-medium text-white shadow-lg sm:left-auto sm:right-7 sm:top-[76px]"
    >
      <CheckIcon className="h-5 w-5 shrink-0 text-green-400" aria-hidden="true" />
      <span className="flex-1">{messages.toast}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={messages.dismiss}
        className="rounded p-1 text-gray-300 outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-white"
      >
        <XMarkIcon className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
