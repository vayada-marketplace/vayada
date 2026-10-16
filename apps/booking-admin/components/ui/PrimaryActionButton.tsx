import { PlusIcon } from "@heroicons/react/24/outline";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * The "+ New …" button in a page header's actions slot. One size on every page, so it doesn't
 * jump when the host switches between Add-ons and Promos (VAY-2229).
 */
export function PrimaryActionButton({
  className,
  children,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white transition-colors enabled:hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <PlusIcon className="h-4 w-4" aria-hidden="true" />
      {children}
    </button>
  );
}
