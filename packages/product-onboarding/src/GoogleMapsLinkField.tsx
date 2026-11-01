"use client";

import { LinkIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";

import { parseGoogleMapsLink, type MapsLinkPin } from "./googleMapsLink";

export type GoogleMapsLinkMessages = {
  label: string;
  /** Before anything is pasted. */
  hint: string;
  /** "Pin placed at {coordinates}". */
  placed: (coordinates: string) => string;
  /** A maps.app.goo.gl link that couldn't be read (or no way to read one). */
  shortLink: string;
  /** While a maps.app.goo.gl link is being read. */
  resolving?: string;
  /** Not a Google Maps link, or one without a place. */
  noPin: string;
  searchInstead: string;
};

// A short link typed by hand is read once the typing pauses.
const RESOLVE_DELAY_MS = 400;

/** "Paste a Google Maps link" (VAY-2321), shared by the PMS room editor and onboarding (VAY-2444): the pin from a
 * place's or a dropped pin's link, as the host types or pastes it. A maps.app.goo.gl share link carries no
 * coordinates: with `resolveShortLink` (the API follows its redirect) its long link is read instead. */
export default function GoogleMapsLinkField({
  inputId,
  messages,
  onPin,
  onClose,
  classNames,
  resolveShortLink = null,
}: {
  inputId: string;
  messages: GoogleMapsLinkMessages;
  onPin: (pin: MapsLinkPin) => void;
  /** "Search an address instead". */
  onClose: () => void;
  classNames: { label: string; input: string; link: string };
  /** The long link a short link opens, or null when it can't be read. */
  resolveShortLink?: ((url: string) => Promise<string | null>) | null;
}) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<ReturnType<typeof parseGoogleMapsLink> | undefined>();
  const [resolving, setResolving] = useState(false);
  // Only the latest text's answer counts; a newer text or unmounting drops an older one.
  const latest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      latest.current += 1;
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function place(found: ReturnType<typeof parseGoogleMapsLink> | undefined) {
    setResult(found);
    if (found && typeof found === "object") onPin(found);
  }

  function read(link: string) {
    setText(link);
    const request = (latest.current += 1);
    if (timer.current) clearTimeout(timer.current);
    setResolving(false);
    const found = link.trim() ? parseGoogleMapsLink(link) : undefined;
    if (found !== "short_link" || !resolveShortLink) return place(found);
    setResult(undefined);
    setResolving(true);
    timer.current = setTimeout(() => {
      void resolveShortLink(link.trim()).then((long) => {
        if (request !== latest.current) return;
        setResolving(false);
        const pin = long ? parseGoogleMapsLink(long) : null;
        place(pin && typeof pin === "object" ? pin : "short_link");
      });
    }, RESOLVE_DELAY_MS);
  }

  const placed = result && typeof result === "object";
  return (
    <div>
      <label htmlFor={inputId} className={classNames.label}>
        {messages.label}
      </label>
      <div className="relative">
        <LinkIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          id={inputId}
          type="text"
          inputMode="url"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(event) => read(event.target.value)}
          onKeyDown={(event) => {
            // Enter reads the link instead of submitting the whole form.
            if (event.key === "Enter") event.preventDefault();
          }}
          aria-describedby={`${inputId}-result`}
          className={`${classNames.input} pl-9`}
          placeholder="https://www.google.com/maps/place/…"
        />
      </div>
      <p
        id={`${inputId}-result`}
        aria-live="polite"
        className={`mt-1 text-[11px] ${
          placed
            ? "font-medium text-green-700"
            : result !== undefined
              ? "font-medium text-amber-700"
              : "text-gray-400"
        }`}
      >
        {resolving
          ? (messages.resolving ?? messages.hint)
          : placed
            ? messages.placed(`${result.latitude}, ${result.longitude}`)
            : result === "short_link"
              ? messages.shortLink
              : result === null
                ? messages.noPin
                : messages.hint}
      </p>
      <button type="button" onClick={onClose} className={`${classNames.link} mt-2`}>
        <MagnifyingGlassIcon className="h-3.5 w-3.5" />
        {messages.searchInstead}
      </button>
    </div>
  );
}
