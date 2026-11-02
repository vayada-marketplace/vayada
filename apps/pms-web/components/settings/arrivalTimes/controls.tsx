import type { ReactNode } from "react";

/** The redesign's controls (Timo's mockup, VAY-2455): 44px touch targets, an amber ring on a required field still
 * open, a red ring on a wrong one. */
export function inputClass(state: "open" | "error" | "ok") {
  const ring =
    state === "error"
      ? "border-red-600 ring-[3px] ring-red-100"
      : state === "open"
        ? "border-amber-500 ring-[3px] ring-amber-100"
        : "border-gray-300";
  return `h-11 w-full rounded-[10px] border bg-white px-3 text-[15px] text-gray-900 ${ring}`;
}

export function Card({
  title,
  subtitle,
  aside,
  className = "",
  children,
}: {
  title: string;
  subtitle: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-2xl border border-gray-200 bg-white p-4 sm:p-6 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold leading-[26px] text-gray-900">{title}</h3>
          <p className="mt-1 text-sm text-gray-600">{subtitle}</p>
        </div>
        {aside}
      </div>
      {children}
    </div>
  );
}

/** "Guests can check in from · Required". */
export function RequiredLabel({
  htmlFor,
  required,
  children,
}: {
  htmlFor?: string;
  required: string;
  children: ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="text-sm font-medium text-gray-700">
      {children} <span className="font-normal text-gray-500">· {required}</span>
    </label>
  );
}

export function Chips({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: string[];
  value: string;
  onPick: (value: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((option) => {
        const on = option === value;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(option)}
            className={`h-10 rounded-full border px-3.5 text-sm font-medium ${
              on
                ? "border-primary-600 bg-primary-50 text-primary-700"
                : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
            }`}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

/** A switch named by the row's title, in a 52×44 target. */
export function Switch({
  checked,
  labelledBy,
  onChange,
}: {
  checked: boolean;
  labelledBy: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      onClick={() => onChange(!checked)}
      className="flex h-11 w-[52px] shrink-0 items-center justify-center"
    >
      <span
        className={`flex h-[26px] w-11 items-center rounded-full p-[3px] transition-colors ${
          checked ? "justify-end bg-primary-600" : "justify-start bg-gray-300"
        }`}
      >
        <span className="block h-5 w-5 rounded-full bg-white shadow" />
      </span>
    </button>
  );
}

export function SwitchRow({
  id,
  title,
  hint,
  checked,
  onChange,
  className = "",
  large = false,
}: {
  id: string;
  title: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  className?: string;
  /** The booking form's rows: 15px titles. */
  large?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        <div
          id={id}
          className={`font-medium ${large ? "text-[15px] text-gray-900" : "text-sm text-gray-700"}`}
        >
          {title}
        </div>
        <div className="mt-0.5 text-[13px] leading-[18px] text-gray-500">{hint}</div>
      </div>
      <Switch checked={checked} labelledBy={id} onChange={onChange} />
    </div>
  );
}

export function FieldAlert({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div id={id} role="alert" className="text-[13px] text-red-700">
      {children}
    </div>
  );
}
