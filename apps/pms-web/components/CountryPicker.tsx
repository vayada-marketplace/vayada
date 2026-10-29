"use client";

import "flag-icons/css/flag-icons.min.css";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { NATIONALITY_OPTIONS } from "@vayada/locale-constants";
import { COUNTRY_DEMONYMS } from "@/lib/countryDemonyms";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";

export type CountryPickerOption = {
  code: string;
  name: string;
  /** "+49": shown on the right and searchable as "+4" or "49". */
  callingCode?: string;
  /** "German": searchable for a nationality. */
  demonyms?: readonly string[];
};

/** Every nationality the booking accepts, searchable by what its people are called. */
export const NATIONALITY_PICKER_OPTIONS: readonly CountryPickerOption[] = NATIONALITY_OPTIONS.map(
  ({ code, name }) => ({ code, name, demonyms: COUNTRY_DEMONYMS.get(code) }),
);

type Match = {
  option: CountryPickerOption;
  rank: number;
  text: string;
  start: number;
  end: number;
};

const normalized = (value: string) => value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Countries matching a search, best first: the exact code or calling code, then names, nationalities
 * and calling codes starting with it, then words inside a name, then anything containing it. */
export function searchCountries(options: readonly CountryPickerOption[], query: string): Match[] {
  const q = normalized(query.trim());
  const none = (option: CountryPickerOption) => ({ option, rank: 0, text: "", start: 0, end: 0 });
  if (!q) return options.map(none);
  const dial = /^\+?\d+$/.test(q) ? q.replace(/^\+/, "") : null;
  const byRank = (left: Match, right: Match) => left.rank - right.rank;
  const matches: Match[] = [];
  for (const option of options) {
    const found: Match[] = [];
    const { callingCode } = option;
    if (dial !== null && callingCode?.slice(1).startsWith(dial))
      found.push({
        option,
        rank: callingCode === `+${dial}` ? 0 : 1,
        text: callingCode,
        start: 0,
        end: dial.length + 1,
      });
    if (dial === null && option.code.toLowerCase() === q)
      found.push({ option, rank: 0, text: option.code, start: 0, end: 2 });
    for (const text of dial === null ? [option.name, ...(option.demonyms ?? [])] : []) {
      const start = normalized(text).indexOf(q);
      if (start < 0) continue;
      const rank = start === 0 ? 1 : /[^a-z]/.test(normalized(text)[start - 1]!) ? 2 : 3;
      found.push({ option, rank, text, start, end: start + q.length });
    }
    const best = found.sort(byRank)[0];
    if (best) matches.push(best);
  }
  return matches.sort(byRank);
}

/** An SVG flag: emoji flags don't render on Windows (VAY-2417). XS (stateless) has none. */
export function CountryFlag({ code }: { code: string }) {
  return (
    <span
      aria-hidden="true"
      className={`fi fi-${code === "XS" ? "xx" : code.toLowerCase()} shrink-0 rounded-sm`}
    />
  );
}

function highlighted(match: Match): ReactNode {
  if (match.end <= match.start) return match.text;
  return (
    <>
      {match.text.slice(0, match.start)}
      <strong className="font-semibold text-gray-900">
        {match.text.slice(match.start, match.end)}
      </strong>
      {match.text.slice(match.end)}
    </>
  );
}

type Props = {
  /** The field's name for screen readers, e.g. "Phone country code". */
  label: string;
  id?: string;
  options: readonly CountryPickerOption[];
  value: string;
  onChange: (code: string) => void;
  placeholder: string;
  /** Listed first while nothing is typed, e.g. the property's country. */
  suggested?: readonly string[];
  /** "dial": the closed field shows flag and calling code; "name": flag and country name. */
  display: "dial" | "name";
  /** Offers a clear button while a country is chosen. */
  clearable?: boolean;
  className?: string;
  triggerClassName?: string;
};

/** One searchable country list for phone codes and nationalities (VAY-2417): a popover inside the
 * field, listbox and option roles, Enter picks the first match and Esc closes only the list. */
export default function CountryPicker({
  label,
  id,
  options,
  value,
  onChange,
  placeholder,
  suggested = [],
  display,
  clearable = false,
  className,
  triggerClassName,
}: Props) {
  const { t } = useTranslation();
  const listId = useId();
  const valueId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const selected = options.find((option) => option.code === value);
  const matches = searchCountries(options, query);
  const suggestions = query.trim()
    ? []
    : Array.from(new Set(suggested))
        .map((code) => matches.find((match) => match.option.code === code))
        .filter((match): match is Match => Boolean(match));
  const rows = [...suggestions, ...matches];
  const optionId = (index: number) => `${listId}-${index}`;

  useEffect(() => {
    if (open) search.current?.focus();
  }, [open]);
  useEffect(() => {
    if (open && typeof document !== "undefined")
      document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, listId, open]);

  const close = (focusTrigger: boolean) => {
    setOpen(false);
    setQuery("");
    setActive(0);
    if (focusTrigger) trigger.current?.focus();
  };
  const choose = (code: string) => {
    onChange(code);
    close(true);
  };
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => Math.min(Math.max(index + step, 0), Math.max(rows.length - 1, 0)));
    } else if (event.key === "Enter") {
      // Never submits the booking form.
      event.preventDefault();
      const row = rows[active];
      if (row) choose(row.option.code);
    } else if (event.key === "Escape") {
      // Closes the list, not the modal around it.
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };

  const section = (heading: string, list: Match[], offset: number) =>
    list.length > 0 && (
      <div role="group" aria-labelledby={`${listId}-g${offset}`}>
        <div
          id={`${listId}-g${offset}`}
          role="presentation"
          className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-gray-500"
        >
          {heading}
        </div>
        {list.map((match, position) => {
          const index = offset + position;
          const { option } = match;
          const byName = match.text === option.name;
          return (
            <div
              key={`${offset}-${option.code}`}
              id={optionId(index)}
              role="option"
              aria-selected={option.code === value}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(option.code)}
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-3 px-3 text-sm text-gray-700",
                index === active && "bg-primary-50",
                option.code === value && "font-medium text-gray-900",
              )}
            >
              <CountryFlag code={option.code} />
              <span className="min-w-0 flex-1 truncate">
                {byName ? highlighted(match) : option.name}
                {!byName && match.text && match.text !== option.callingCode && (
                  <span className="text-gray-500"> · {highlighted(match)}</span>
                )}
              </span>
              {option.callingCode && (
                <span className="shrink-0 tabular-nums text-gray-500">
                  {match.text === option.callingCode ? highlighted(match) : option.callingCode}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );

  return (
    <div
      className={cn("relative", className)}
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) close(false);
      }}
    >
      <button
        ref={trigger}
        id={id}
        type="button"
        value={value}
        aria-label={label}
        aria-describedby={valueId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" || open) return;
          event.preventDefault();
          setOpen(true);
        }}
        className={cn("flex min-h-11 items-center gap-2 text-left", triggerClassName)}
      >
        {selected && <CountryFlag code={selected.code} />}
        <span id={valueId} className={cn("min-w-0 flex-1 truncate", !selected && "text-gray-400")}>
          {selected ? (display === "dial" ? selected.callingCode : selected.name) : placeholder}
        </span>
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 20 20"
          fill="none"
          className="shrink-0 text-gray-500"
        >
          <path
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            d="m6 8 4 4 4-4"
          />
        </svg>
      </button>
      {clearable && selected && !open && (
        <button
          type="button"
          aria-label={t("common.countryPicker.clear", { field: label })}
          onClick={() => onChange("")}
          className="absolute right-8 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded text-gray-400 hover:text-gray-700"
        >
          ×
        </button>
      )}
      {open && (
        <div
          className="absolute left-0 z-20 mt-1 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg"
          // Clicks inside keep the search focused, so the list stays open.
          onMouseDown={(event) => {
            if (event.target !== search.current) event.preventDefault();
          }}
        >
          <div className="border-b border-gray-100 p-2">
            <input
              ref={search}
              type="text"
              role="combobox"
              aria-label={
                display === "dial"
                  ? t("common.countryPicker.searchDial")
                  : t("common.countryPicker.searchName")
              }
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={rows.length ? optionId(active) : undefined}
              placeholder={
                display === "dial"
                  ? t("common.countryPicker.searchDial")
                  : t("common.countryPicker.searchName")
              }
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onSearchKey}
              className="h-11 w-full rounded-lg border border-gray-300 px-3 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label={label}
            className="max-h-72 overflow-y-auto pb-1"
          >
            {section(t("common.countryPicker.suggested"), suggestions, 0)}
            {section(
              query.trim() ? t("common.countryPicker.matches") : t("common.countryPicker.all"),
              matches,
              suggestions.length,
            )}
            {rows.length === 0 && (
              <p className="px-3 py-3 text-sm text-gray-500">
                {t("common.countryPicker.noMatches", { query: query.trim() })}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
