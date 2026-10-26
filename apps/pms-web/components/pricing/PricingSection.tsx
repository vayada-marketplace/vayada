"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ChevronDownIcon } from "@heroicons/react/24/outline";

/** A collapsible row, styled like Room Details' amenity categories. A native <details> keeps its content mounted
 * while closed, so a half-entered rule and its pending-edit guard survive collapsing. The visible title stays short;
 * `label` is the row's full accessible name (with the room and offer, and its `value` if shown), so screen readers
 * and tests can tell the rows of different offers apart. With `keepOpen` (an unsaved edit in the row) the row opens
 * and cannot be closed, so the edit that holds back Save stays in sight. */
export function PricingSection({
  title,
  label,
  value,
  keepOpen = false,
  children,
}: {
  title: string;
  label?: string;
  value?: string;
  keepOpen?: boolean;
  children: ReactNode;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (keepOpen && details.current) details.current.open = true;
  }, [keepOpen]);
  return (
    <details ref={details} className="group rounded-lg border border-gray-200 bg-white">
      <summary
        aria-label={label}
        onClick={(event) => {
          if (keepOpen) event.preventDefault();
        }}
        className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 transition-colors hover:bg-gray-50 [&::-webkit-details-marker]:hidden"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChevronDownIcon
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 -rotate-90 text-gray-400 transition-transform group-open:rotate-0"
          />
          <span className="text-[12px] font-semibold text-gray-900">{title}</span>
        </span>
        {value && <span className="shrink-0 text-[11px] text-gray-400">{value}</span>}
      </summary>
      <div className="space-y-2 px-4 pb-4 text-[12px] text-gray-700">{children}</div>
    </details>
  );
}
