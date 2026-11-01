"use client";

import { LinkIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useState } from "react";

import { parseGoogleMapsLink, type MapsLinkPin } from "./googleMapsLink";

export type GoogleMapsLinkMessages = {
  label: string;
  /** Before anything is pasted. */
  hint: string;
  /** "Pin placed at {coordinates}". */
  placed: (coordinates: string) => string;
  /** A maps.app.goo.gl link, which carries no coordinates. */
  shortLink: string;
  /** Not a Google Maps link, or one without a place. */
  noPin: string;
  searchInstead: string;
};

/** "Paste a Google Maps link" (VAY-2321), shared by the PMS room editor and onboarding (VAY-2444): the pin from a
 * place's or a dropped pin's link, as the host types or pastes it. */
export default function GoogleMapsLinkField({
  inputId,
  messages,
  onPin,
  onClose,
  classNames,
}: {
  inputId: string;
  messages: GoogleMapsLinkMessages;
  onPin: (pin: MapsLinkPin) => void;
  /** "Search an address instead". */
  onClose: () => void;
  classNames: { label: string; input: string; link: string };
}) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<ReturnType<typeof parseGoogleMapsLink> | undefined>();

  function read(link: string) {
    setText(link);
    const found = link.trim() ? parseGoogleMapsLink(link) : undefined;
    setResult(found);
    if (found && typeof found === "object") onPin(found);
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
          aria-invalid={result === null || result === "short_link" || undefined}
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
        {placed
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
