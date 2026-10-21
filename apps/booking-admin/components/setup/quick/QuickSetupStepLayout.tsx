"use client";

import { ArrowRightIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";

export type QuickSetupFooterProps = {
  /** Desktop only, left of the buttons: "Saved as you type". */
  note?: string | null;
  onBack?: (() => void) | null;
  backDisabled?: boolean;
  primaryLabel: string;
  /** The primary button submits this form (wherever the footer sits), or calls onPrimary. */
  formId?: string;
  onPrimary?: (() => void) | null;
  primaryDisabled?: boolean;
  primaryBusy?: boolean;
  primaryBusyLabel?: string;
};

export type QuickSetupStepLayoutProps = {
  title: string;
  subtitle: string;
  /** Above the title inside the form card (e.g. "Welcome back"). */
  banner?: ReactNode;
  /** The form fields. */
  children: ReactNode;
  footer: QuickSetupFooterProps;
  /** The right-hand card; under the form on phones. Without one, the form card sits centred (About you). */
  preview?: ReactNode;
};

/**
 * VAY-2247 setup step (Paper rev 3/4 cards; 7 steps, approved 2026-10-21): the form in a white card on the
 * page background, the preview in its own card centred next to it, or the form card alone and centred. On
 * phones the cards stack and the buttons move into a white bar under them.
 */
export function QuickSetupStepLayout({
  title,
  subtitle,
  banner,
  children,
  footer,
  preview,
}: QuickSetupStepLayoutProps) {
  return (
    <>
      <div
        className={`mx-auto flex w-full max-w-[1440px] flex-col gap-4 px-4 pb-6 pt-4 lg:flex-row lg:items-stretch lg:gap-8 lg:px-12 lg:pb-16 lg:pt-10 ${
          preview ? "" : "lg:justify-center"
        }`}
      >
        <section
          aria-labelledby="quick-setup-heading"
          className="flex min-w-0 flex-col gap-6 rounded-2xl border border-gray-200 bg-white px-[23px] py-6 lg:w-[642px] lg:shrink-0 lg:gap-8 lg:p-8"
        >
          {banner}
          <header>
            <h1
              id="quick-setup-heading"
              tabIndex={-1}
              className="text-[26px] font-bold leading-tight tracking-tight text-gray-950 outline-none lg:text-[30px]"
            >
              {title}
            </h1>
            <p className="mt-1.5 text-[15px] leading-6 text-gray-600 lg:mt-2 lg:text-base">
              {subtitle}
            </p>
          </header>
          {children}
          <div className="hidden lg:block">
            <QuickSetupFooter {...footer} />
          </div>
        </section>
        {preview ? (
          <div className="flex min-w-0 flex-col lg:flex-1 lg:justify-center">{preview}</div>
        ) : null}
      </div>
      <div className="lg:hidden">
        <QuickSetupMobileFooter {...footer} />
      </div>
    </>
  );
}

const BACK =
  "inline-flex h-11 items-center justify-center rounded-full px-5 text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40";
const PRIMARY =
  "inline-flex h-11 items-center justify-center gap-2 rounded-full bg-primary-600 px-5 text-base font-semibold text-white outline-none hover:bg-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

function PrimaryButton({
  primaryLabel,
  formId,
  onPrimary,
  primaryDisabled = false,
  primaryBusy = false,
  primaryBusyLabel,
  className,
}: QuickSetupFooterProps & { className: string }) {
  return (
    <button
      type={formId ? "submit" : "button"}
      form={formId}
      onClick={formId ? undefined : (onPrimary ?? undefined)}
      disabled={primaryDisabled || primaryBusy}
      aria-busy={primaryBusy || undefined}
      className={`${PRIMARY} ${className}`}
    >
      {primaryBusy ? (primaryBusyLabel ?? primaryLabel) : primaryLabel}
      {primaryBusy ? null : <ArrowRightIcon className="h-5 w-5" aria-hidden="true" />}
    </button>
  );
}

export function QuickSetupFooter(props: QuickSetupFooterProps) {
  const { note, onBack, backDisabled = false } = props;
  return (
    <div className="flex items-center gap-3 border-t border-gray-100 pt-6">
      {note ? <p className="text-[13px] text-gray-500">{note}</p> : null}
      <div className="ml-auto flex items-center gap-3">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            disabled={backDisabled}
            className={`${BACK} border border-gray-300 bg-white text-gray-950 hover:bg-gray-50`}
          >
            Back
          </button>
        ) : null}
        <PrimaryButton {...props} className="" />
      </div>
    </div>
  );
}

function QuickSetupMobileFooter(props: QuickSetupFooterProps) {
  const { onBack, backDisabled = false } = props;
  return (
    <div className="flex flex-col gap-2.5 border-t border-gray-200 bg-white px-4 pb-7 pt-3">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          disabled={backDisabled}
          className={`${BACK} w-full text-gray-700 hover:bg-gray-50`}
        >
          Back
        </button>
      ) : null}
      <PrimaryButton {...props} className="w-full" />
    </div>
  );
}
