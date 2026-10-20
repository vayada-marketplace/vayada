"use client";

import Image from "next/image";
import type { ReactNode } from "react";

/** The new first run has five steps: About you, Your hotel, First room and price, How guests pay, Go live. */
export const QUICK_SETUP_TOTAL_STEPS = 5;

export type QuickSetupShellProps = {
  /** The step shown in the header; null after setup ("You're live"): the logo only. */
  step: number | null;
  totalSteps?: number;
  /** Shown top right while setup is running; absent → no link. */
  onSaveAndExit?: (() => void) | null;
  saveAndExitDisabled?: boolean;
  children: ReactNode;
};

/**
 * VAY-2247 setup shell (Paper rev 4, header C2): no top bar. The logo sits centred on the page
 * background with "Step N of 5" over five segments, and "Save & exit" is a small link top right.
 */
export function QuickSetupShell({
  step,
  totalSteps = QUICK_SETUP_TOTAL_STEPS,
  onSaveAndExit,
  saveAndExitDisabled = false,
  children,
}: QuickSetupShellProps) {
  const total = Math.max(1, totalSteps);
  const current = step === null ? null : Math.min(total, Math.max(1, step));

  return (
    <main className="min-h-[100dvh] bg-gray-50 text-gray-950">
      <header className="mx-auto w-full max-w-[1440px] px-4 pt-4 lg:px-12 lg:pt-7">
        <div className="grid grid-cols-[1fr_auto_1fr] items-start">
          <span aria-hidden="true" />
          <div className="flex flex-col items-center gap-3 lg:gap-4">
            <Image
              src="/vayada-logo.png"
              alt="vayada"
              width={36}
              height={32}
              priority
              className="h-6 w-auto lg:h-8"
            />
            {current !== null ? <QuickSetupProgress current={current} total={total} /> : null}
          </div>
          <div className="flex justify-end pt-[3px] lg:pt-1.5">
            {current !== null && onSaveAndExit ? (
              <button
                type="button"
                onClick={onSaveAndExit}
                disabled={saveAndExitDisabled}
                className="whitespace-nowrap rounded text-[13px] font-semibold text-primary-600 outline-none hover:text-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 lg:text-sm"
              >
                Save &amp; exit
              </button>
            ) : null}
          </div>
        </div>
      </header>
      {children}
    </main>
  );
}

function QuickSetupProgress({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex flex-col items-center gap-1.5 lg:gap-2">
      <p className="whitespace-nowrap text-xs font-semibold text-gray-600 lg:text-[13px]">
        {`Step ${current} of ${total}`}
      </p>
      <div
        className="flex w-[200px] items-center gap-1 lg:w-80 lg:gap-1.5"
        role="progressbar"
        aria-label="Hotel setup progress"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={current}
        aria-valuetext={`Step ${current} of ${total}`}
      >
        {Array.from({ length: total }, (_, index) => (
          <span
            key={index}
            aria-hidden="true"
            className={`h-[5px] flex-1 rounded-full lg:h-1.5 ${
              index < current ? "bg-primary-600" : "bg-primary-100"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
