"use client";
import React, { useEffect, useId, useRef, useState } from "react";
import { EllipsisHorizontalIcon } from "@heroicons/react/24/outline";

export type TeamRowMenuItem = {
  label: string;
  ariaLabel?: string;
  danger?: boolean;
  onSelect: () => void;
};

// A small menu button: arrow keys move between items, Escape and focus leaving close it, and focus
// returns to the button before an item runs, so a dialog it opens can hand focus back there.
export default function TeamRowMenu({
  label,
  items,
  disabled,
}: {
  label: string;
  items: TeamRowMenuItem[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const menuItems = () =>
    Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    menuItems()[0]?.focus();
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (!open) return;
    const all = menuItems();
    const index = all.indexOf(document.activeElement as HTMLButtonElement);
    const move: Record<string, number> = {
      ArrowDown: (index + 1) % all.length,
      ArrowUp: (index - 1 + all.length) % all.length,
      Home: 0,
      End: all.length - 1,
    };
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    } else if (event.key in move) {
      event.preventDefault();
      all[move[event.key]!]?.focus();
    }
  }

  return (
    <div
      className="relative"
      ref={ref}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!ref.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        // Safari doesn't focus buttons on click: keep focus in the menu so it isn't closed by blur first.
        onMouseDown={(event) => {
          if (open) event.preventDefault();
        }}
        onClick={() => setOpen((value) => !value)}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <EllipsisHorizontalIcon aria-hidden="true" className="h-4 w-4" />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          // Same Safari reason: a click on an item must not blur the menu (and unmount it) before it runs.
          onMouseDown={(event) => event.preventDefault()}
          className="absolute right-0 z-10 mt-1 w-52 rounded-lg border border-gray-200 bg-white p-1.5 shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-label={item.ariaLabel}
              onClick={() => {
                trigger.current?.focus();
                setOpen(false);
                item.onSelect();
              }}
              className={`block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-gray-50 focus:bg-gray-50 focus:outline-none ${item.danger ? "text-red-600" : "text-gray-700"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
