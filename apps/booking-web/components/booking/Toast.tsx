"use client";

import { useEffect } from "react";

/** A short confirmation at the bottom of the screen (VAY-2393), read out by screen readers: the
 * live region stays on the page (without a status role while it is empty) so each new message is
 * announced. It closes itself; a new toast (another id) starts its own time. */
export default function Toast({
  toast,
  onClose,
  duration = 4000,
}: {
  toast: { id: number; message: string } | null;
  onClose: () => void;
  duration?: number;
}) {
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(onClose, duration);
    return () => clearTimeout(timer);
    // Only a new toast restarts the time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast?.id, duration]);
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      // Above the privacy settings pill on a phone.
      className="pointer-events-none fixed inset-x-4 bottom-[calc(4rem+var(--fixed-bottom-bar,0px))] z-50 flex justify-center md:bottom-8"
    >
      {toast && (
        <p
          role="status"
          data-testid="toast"
          className="pointer-events-auto max-w-md rounded-full bg-gray-900 px-5 py-3 text-center text-sm font-medium text-white shadow-lg"
        >
          {toast.message}
        </p>
      )}
    </div>
  );
}
