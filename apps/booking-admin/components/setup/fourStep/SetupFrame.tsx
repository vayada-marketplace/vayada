"use client";

import { ArrowLeftIcon, ArrowRightIcon, CheckIcon } from "@heroicons/react/24/outline";
import Image from "next/image";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * VAY-2451: the four setup steps, in order (Timo's mockup, approved by Flamur 2026-11-02 in place of
 * Paper). The rail, the welcome card and the dashboard tiles all show these.
 */
export const SETUP_STEPS = [
  { id: "property", label: "Your property", description: "Name, type and logo", minutes: 1 },
  {
    id: "location",
    label: "Location & contact",
    description: "Address, contact and socials",
    minutes: 2,
  },
  {
    id: "room",
    label: "First room",
    description: "Optional · everything but prices",
    minutes: 5,
  },
  { id: "payments", label: "Guest payments", description: "How guests pay you", minutes: 1 },
] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number]["id"];

export type SetupFooterProps = {
  onBack?: (() => void) | null;
  /** Off while a save or an upload runs, so the screen can't move under it. */
  backDisabled?: boolean;
  primaryLabel: string;
  onPrimary?: (() => void) | null;
  primaryDisabled?: boolean;
  primaryBusy?: boolean;
  primaryBusyLabel?: string;
  /** Why Continue is off ("Add a room name and size to continue"); next to the button, above it below 1280 px. */
  hint?: string | null;
  /** "Skip for now" on the room steps. */
  onSkip?: (() => void) | null;
  skipDisabled?: boolean;
};

export type SetupFrameProps = {
  step: SetupStepId;
  /** The furthest step the owner may open: later ones are locked, earlier ones show a tick. */
  reached: number;
  /** Every step is done (editing after setup): all show a tick and none is locked. */
  finished?: boolean;
  /** "Setting up …" in the rail; the step's own name until the owner types one. */
  propertyName: string;
  /** After "Step 3 of 4", e.g. "Room basics, 1 of 3". */
  subStep?: string | null;
  onPickStep?: ((step: SetupStepId) => void) | null;
  /** Which done steps can be opened (all of them when not given). */
  canPickStep?: ((step: SetupStepId) => boolean) | null;
  onSaveAndExit: () => void;
  saveAndExitDisabled?: boolean;
  footer: SetupFooterProps;
  /** Beside the form on wide screens (step 1's booking page preview); never on phones. */
  aside?: ReactNode;
  children: ReactNode;
};

const PRIMARY =
  "inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-primary-600 px-6 text-[15px] font-semibold text-white outline-none hover:bg-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-gray-400";
const SECONDARY =
  "inline-flex h-12 items-center justify-center rounded-xl border border-gray-300 bg-white text-[15px] font-semibold text-gray-700 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * VAY-2451 setup frame: on wide screens a left rail with the four steps, the step's header with "Step N of 4"
 * and "Save & exit", the step scrolling in the middle and a footer that always stays in view. Below 1024 px
 * the rail goes and the progress bar runs under the header; below 720 px the footer becomes a bottom bar.
 * A new step or sub-step opens at the top with its heading focused.
 */
export function SetupFrame({
  step,
  reached,
  finished = false,
  propertyName,
  subStep,
  onPickStep,
  canPickStep,
  onSaveAndExit,
  saveAndExitDisabled = false,
  footer,
  aside,
  children,
}: SetupFrameProps) {
  const current = SETUP_STEPS.findIndex((item) => item.id === step);
  const label = `Step ${current + 1} of ${SETUP_STEPS.length}`;
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo?.({ top: 0 });
    if (typeof document !== "undefined")
      document.getElementById("setup-step-heading")?.focus({ preventScroll: true });
  }, [step, subStep]);
  return (
    <div className="flex h-[100dvh] bg-gray-50 text-gray-950">
      <aside className="hidden w-[300px] shrink-0 flex-col border-r border-gray-200 bg-white px-5 py-7 min-[1024px]:flex">
        <div className="px-3">
          <Image
            src="/vayada-logo.png"
            alt="vayada"
            width={36}
            height={32}
            priority
            className="h-7 w-auto"
          />
        </div>
        <div className="mt-9 px-3">
          <p className="text-xs font-semibold uppercase tracking-[0.06em] text-gray-500">
            Setting up
          </p>
          <p className="mt-1 truncate text-[17px] font-semibold leading-snug">{propertyName}</p>
        </div>
        <nav aria-label="Setup steps" className="mt-5 flex flex-col gap-1">
          {SETUP_STEPS.map((item, index) => {
            const isCurrent = index === current;
            const done = !isCurrent && (finished || index < reached);
            const locked = !finished && index > reached;
            return (
              <button
                key={item.id}
                type="button"
                disabled={locked || isCurrent || !onPickStep || canPickStep?.(item.id) === false}
                aria-current={isCurrent ? "step" : undefined}
                onClick={() => onPickStep?.(item.id)}
                className={`flex w-full items-start gap-3 rounded-xl p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-600 disabled:cursor-default ${
                  isCurrent ? "bg-primary-50" : "enabled:hover:bg-gray-50"
                }`}
              >
                <span
                  className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ${
                    done
                      ? "bg-green-500 text-white"
                      : isCurrent
                        ? "bg-primary-600 text-white"
                        : "border-[1.5px] border-gray-300 bg-white text-gray-500"
                  }`}
                >
                  {done ? (
                    <>
                      <CheckIcon className="h-4 w-4 stroke-[3]" aria-hidden="true" />
                      <span className="sr-only">Done:</span>
                    </>
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="flex flex-col gap-0.5 pt-1">
                  <span
                    className={`text-[15px] font-semibold ${locked ? "text-gray-500" : "text-gray-950"}`}
                  >
                    {item.label}
                  </span>
                  <span className="text-[13px] text-gray-500">{item.description}</span>
                </span>
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-3.5 min-[720px]:px-14 min-[720px]:pt-6">
          <div className="flex items-center gap-3">
            <Image
              src="/vayada-logo.png"
              alt="vayada"
              width={27}
              height={24}
              className="h-6 w-auto min-[1024px]:hidden"
            />
            <p className="text-[13px] font-semibold text-primary-600">
              {label}
              {subStep ? (
                <span className="font-medium text-gray-600">{` · ${subStep}`}</span>
              ) : null}
            </p>
            <Progress current={current} className="hidden gap-1 min-[1024px]:flex" bar="w-7" />
          </div>
          <button
            type="button"
            onClick={onSaveAndExit}
            disabled={saveAndExitDisabled}
            className="h-10 shrink-0 rounded-lg px-3.5 text-sm font-semibold text-primary-600 outline-none hover:text-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save &amp; exit
          </button>
        </div>
        <Progress
          current={current}
          className="flex gap-1 px-4 pt-2.5 min-[720px]:px-14 min-[1024px]:hidden"
          bar="flex-1"
        />

        <div
          ref={scroller}
          className="relative min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-5 min-[720px]:px-14 min-[720px]:pb-8"
        >
          <div className="flex flex-wrap items-start gap-12">
            <div className="min-w-0 max-w-[620px] flex-[1_1_480px]">{children}</div>
            {aside ? (
              <div className="hidden min-w-[300px] flex-[0_1_380px] pt-1.5 min-[720px]:block">
                {aside}
              </div>
            ) : null}
          </div>
        </div>

        <SetupFooter {...footer} />
      </main>
    </div>
  );
}

function Progress({
  current,
  className,
  bar,
}: {
  current: number;
  className: string;
  bar: string;
}) {
  return (
    <div
      className={className}
      role="progressbar"
      aria-label="Setup progress"
      aria-valuemin={1}
      aria-valuemax={SETUP_STEPS.length}
      aria-valuenow={current + 1}
      aria-valuetext={`Step ${current + 1} of ${SETUP_STEPS.length}`}
    >
      {SETUP_STEPS.map((item, index) => (
        <span
          key={item.id}
          aria-hidden="true"
          className={`h-1 rounded ${bar} ${index <= current ? "bg-primary-600" : "bg-primary-100"}`}
        />
      ))}
    </div>
  );
}

function SetupFooter({
  onBack,
  backDisabled = false,
  primaryLabel,
  onPrimary,
  primaryDisabled = false,
  primaryBusy = false,
  primaryBusyLabel,
  hint,
  onSkip,
  skipDisabled = false,
}: SetupFooterProps) {
  return (
    <div className="shrink-0 border-t border-gray-200 bg-white px-4 py-3 min-[720px]:px-14 min-[720px]:py-4">
      {hint ? (
        <p
          className="mb-2 text-[13px] font-medium text-amber-700 min-[1280px]:hidden"
          aria-live="polite"
        >
          {hint}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2.5">
        {onBack ? (
          <>
            <div className="hidden items-center gap-4 min-[720px]:flex">
              <button
                type="button"
                onClick={onBack}
                disabled={backDisabled}
                className={`${SECONDARY} px-5`}
              >
                Back
              </button>
              <SavedAsYouGo />
            </div>
            <button
              type="button"
              onClick={onBack}
              disabled={backDisabled}
              aria-label="Back"
              className={`${SECONDARY} w-12 shrink-0 min-[720px]:hidden`}
            >
              <ArrowLeftIcon className="h-[18px] w-[18px] stroke-2" aria-hidden="true" />
            </button>
          </>
        ) : (
          <div className="hidden min-[720px]:flex">
            <SavedAsYouGo />
          </div>
        )}
        <div className="flex flex-1 items-center justify-end gap-2.5 min-[720px]:flex-none">
          {hint ? (
            <p className="hidden text-[13px] font-medium text-amber-700 min-[1280px]:block">
              {hint}
            </p>
          ) : null}
          {onSkip ? (
            <button
              type="button"
              onClick={onSkip}
              disabled={skipDisabled || primaryBusy}
              className="h-12 shrink-0 rounded-xl px-2.5 text-[15px] font-semibold text-gray-600 outline-none hover:text-gray-950 focus-visible:ring-2 focus-visible:ring-primary-600 disabled:opacity-50 min-[720px]:px-[18px]"
            >
              Skip for now
            </button>
          ) : null}
          <button
            type="button"
            onClick={onPrimary ?? undefined}
            disabled={primaryDisabled || primaryBusy}
            aria-busy={primaryBusy || undefined}
            className={`${PRIMARY} flex-1 min-[720px]:flex-none`}
          >
            {primaryBusy ? (primaryBusyLabel ?? primaryLabel) : primaryLabel}
            {primaryBusy ? null : (
              <ArrowRightIcon className="h-[18px] w-[18px] stroke-2" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function SavedAsYouGo() {
  return (
    <span className="flex items-center gap-1.5 text-[13px] text-gray-500">
      <CheckIcon className="h-4 w-4 stroke-[2.4] text-green-500" aria-hidden="true" />
      Saved as you go
    </span>
  );
}
