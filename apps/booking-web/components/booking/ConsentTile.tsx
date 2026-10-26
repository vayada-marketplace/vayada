import type { ReactNode } from "react";

/** A tick on the payment step (VAY-2306), drawn like the ways to pay above it: the whole tile
 * ticks the box, and the hotel's colour shows it ticked. `children` (the "Read …" button) sits
 * above the tile's click area, so it opens the text without ticking. The ring sits on the tile;
 * a browser without :has() keeps the box's own focus outline. */
export default function ConsentTile({
  label,
  checked,
  disabled,
  errorId,
  onChange,
  children,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  /** Confirm was pressed before ticking: the id of the message that says so. */
  errorId?: string;
  onChange: (checked: boolean) => void;
  children?: ReactNode;
}) {
  const invalid = !!errorId && !checked && !disabled;
  const tone = disabled
    ? "border-gray-200 bg-gray-50 text-gray-400"
    : invalid
      ? "border-red-600 bg-red-50 text-gray-700"
      : checked
        ? "border-primary-600 bg-primary-50 font-medium text-gray-900"
        : "border-gray-200 bg-white text-gray-700 hover:border-gray-300";
  return (
    <div
      className={`relative rounded-xl border-2 px-4 py-3.5 text-sm transition-colors has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-primary-600 has-[input:focus-visible]:ring-offset-2 ${tone}`}
    >
      <label
        className={`flex items-start gap-3 after:absolute after:inset-0 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      >
        <span className="relative z-10 flex shrink-0">
          <input
            type="checkbox"
            data-consent
            className="peer h-5 w-5 cursor-pointer appearance-none rounded-md border-[1.5px] border-gray-500 bg-white [@supports_selector(:has(*))]:focus:outline-none checked:border-primary-600 checked:bg-primary-600 disabled:cursor-not-allowed disabled:border-gray-300 disabled:bg-gray-100 aria-[invalid=true]:border-red-600 aria-[invalid=true]:bg-red-50"
            checked={checked}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errorId : undefined}
            onChange={(event) => onChange(event.target.checked)}
          />
          <svg
            className="pointer-events-none absolute inset-0 m-auto hidden h-3.5 w-3.5 text-white peer-checked:block"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        </span>
        <span>{label}</span>
      </label>
      {children && <div className="relative z-10 ml-8 mt-0.5 w-fit">{children}</div>}
    </div>
  );
}
