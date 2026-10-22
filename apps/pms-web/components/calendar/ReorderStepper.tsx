"use client";

// Up/down pair for the calendar's "Reorder rooms" mode (VAY-2294). Bordered and dark so
// it reads as a control, not as the faint chevrons the earlier arrows were mistaken for.
export default function ReorderStepper({
  upLabel,
  downLabel,
  upDisabled,
  downDisabled,
  onUp,
  onDown,
}: {
  upLabel: string;
  downLabel: string;
  upDisabled: boolean;
  downDisabled: boolean;
  onUp: () => void;
  onDown: () => void;
}) {
  const half =
    "flex-1 flex items-center justify-center text-gray-700 hover:bg-gray-100 focus-visible:outline-none focus-visible:bg-primary-50 focus-visible:text-primary-700 disabled:text-gray-300 disabled:hover:bg-transparent disabled:cursor-not-allowed";
  return (
    <div className="w-6 h-9 flex-shrink-0 flex flex-col overflow-hidden rounded-md border border-gray-300 bg-white">
      <button
        type="button"
        onClick={onUp}
        disabled={upDisabled}
        aria-label={upLabel}
        title={upLabel}
        className={`${half} border-b border-gray-200`}
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" />
        </svg>
      </button>
      <button
        type="button"
        onClick={onDown}
        disabled={downDisabled}
        aria-label={downLabel}
        title={downLabel}
        className={half}
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
    </div>
  );
}
