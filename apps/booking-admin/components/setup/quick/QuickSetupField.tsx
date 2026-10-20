"use client";

import { ExclamationCircleIcon } from "@heroicons/react/24/outline";
import { useId, type InputHTMLAttributes, type ReactNode } from "react";

export const QUICK_SETUP_INPUT =
  "h-11 w-full rounded-[10px] border bg-white px-3.5 text-[15px] text-gray-950 outline-none transition placeholder:text-gray-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-100";

export type QuickSetupFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  /** Under the input; replaced by the error when there is one. */
  helper?: ReactNode;
  error?: string | null;
  /** Inside the input, on the right (e.g. the currency). */
  suffix?: ReactNode;
  inputProps?: Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "id" | "value" | "onChange" | "aria-invalid" | "aria-describedby" | "required"
  >;
};

/** VAY-2247 setup field (Paper rev 4): label with a red star when required, the input, then help or the error. */
export function QuickSetupField({
  label,
  value,
  onChange,
  required = false,
  helper,
  error,
  suffix,
  inputProps,
}: QuickSetupFieldProps) {
  const id = `quick-setup-${useId()}`;
  const noteId = error || helper ? `${id}-note` : undefined;

  return (
    <div className="flex min-w-0 flex-col">
      <label htmlFor={id} className="text-sm font-semibold text-gray-950">
        {label}
        {required ? (
          <span aria-hidden="true" className="ml-1 text-red-600">
            *
          </span>
        ) : null}
      </label>
      <div className="relative mt-2">
        <input
          {...inputProps}
          id={id}
          value={value}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={noteId}
          onChange={(event) => onChange(event.target.value)}
          className={`${QUICK_SETUP_INPUT} ${suffix ? "pr-14" : ""} ${
            error ? "border-red-600" : "border-gray-300"
          }`}
        />
        {suffix ? (
          <span className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-sm font-medium text-gray-500">
            {suffix}
          </span>
        ) : null}
      </div>
      {error ? (
        <p id={noteId} className="mt-2 flex items-start gap-1.5 text-[13px] text-red-700">
          <ExclamationCircleIcon className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : helper ? (
        <p id={noteId} className="mt-2 text-[13px] leading-5 text-gray-500">
          {helper}
        </p>
      ) : null}
    </div>
  );
}
