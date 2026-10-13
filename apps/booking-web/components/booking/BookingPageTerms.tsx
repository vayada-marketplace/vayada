"use client";

import { useId } from "react";

/** The hotel's own Terms & Conditions under its guest rules on /book (VAY-2176). */
export default function BookingPageTerms({ text }: { text: string }) {
  const headingId = useId();
  return (
    <div className="space-y-3 rounded-xl border border-gray-200 p-5">
      <h2 id={headingId} className="text-xl font-semibold">
        Our terms & conditions
      </h2>
      {/* A named, focusable region so keyboard and screen-reader users can scroll long terms. */}
      <div
        role="region"
        aria-labelledby={headingId}
        tabIndex={0}
        className="max-h-64 overflow-y-auto rounded-lg bg-gray-50 p-3 text-sm"
      >
        <p className="whitespace-pre-wrap break-words">{text}</p>
      </div>
    </div>
  );
}
