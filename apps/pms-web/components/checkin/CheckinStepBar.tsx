"use client";

import Link from "next/link";
import { ArrowLeftIcon, CheckIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "@/lib/i18n";

export type CheckinStepState = "done" | "current" | "todo";

export interface CheckinStepItem {
  title: string;
  summary: string;
  state: CheckinStepState;
}

/** Laptop: the four steps side by side, each clickable (VAY-2373, approved in Paper p-16-0). */
export function CheckinStepBar({
  steps,
  onSelect,
}: {
  steps: CheckinStepItem[];
  onSelect: (index: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("checkIn.flow.steps")} className="hidden md:block">
      <ol className="grid grid-cols-4 gap-2 rounded-2xl border border-gray-200 bg-white p-2">
        {steps.map((step, index) => (
          <li key={step.title} className="min-w-0">
            <button
              type="button"
              onClick={() => onSelect(index)}
              aria-current={step.state === "current" ? "step" : undefined}
              className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left focus-visible:ring-2 focus-visible:ring-primary-500 ${
                step.state === "current"
                  ? "bg-primary-50 shadow-[inset_0_0_0_2px] shadow-primary-600"
                  : "hover:bg-gray-50"
              }`}
            >
              <StepDot index={index} state={step.state} />
              <span className="min-w-0">
                <span className="block truncate text-[15px] font-bold text-gray-900">
                  {step.title}
                </span>
                <span className="block truncate text-sm text-gray-600">{step.summary}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function StepDot({ index, state }: { index: number; state: CheckinStepState }) {
  if (state === "done")
    return (
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-600 text-white"
      >
        <CheckIcon className="h-4 w-4" strokeWidth={2.5} aria-hidden="true" />
      </span>
    );
  return (
    <span
      aria-hidden="true"
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
        state === "current"
          ? "bg-primary-600 text-white"
          : "border-2 border-gray-300 bg-white text-gray-600"
      }`}
    >
      {index + 1}
    </span>
  );
}

/** Phone: one line with the guest, "2/4" and a segment per step. */
export function CheckinPhoneHeader({
  name,
  arrival,
  steps,
  backHref,
}: {
  name: string;
  arrival: string;
  steps: CheckinStepItem[];
  backHref: string;
}) {
  const { t } = useTranslation();
  const current = steps.findIndex((step) => step.state === "current");
  return (
    <div className="-mx-4 -mt-4 mb-4 border-b border-gray-200 bg-white px-4 pb-3 pt-3 md:hidden">
      <div className="flex items-center gap-3">
        <Link
          href={backHref}
          aria-label={t("checkIn.flow.toDashboard")}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-900"
        >
          <ArrowLeftIcon className="h-5 w-5" aria-hidden="true" />
        </Link>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-base font-bold text-gray-900">{name}</p>
          <p className="truncate text-xs font-semibold text-green-700">{arrival}</p>
        </div>
        <p className="w-9 shrink-0 text-right text-sm font-semibold text-gray-600">
          {t("checkIn.flow.stepFraction", { step: current + 1, total: steps.length })}
        </p>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-1.5" aria-hidden="true">
        {steps.map((step) => (
          <span
            key={step.title}
            className={`h-1 rounded-full ${
              step.state === "done"
                ? "bg-green-600"
                : step.state === "current"
                  ? "bg-primary-600"
                  : "bg-gray-200"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
