"use client";

import { useId, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, EllipsisVerticalIcon } from "@heroicons/react/24/outline";
import {
  ACCOUNT_BOOKING_PAGE_FILTERS,
  ACCOUNT_BOOKING_PAGE_LAYOUTS,
  ACCOUNT_BOOKING_PAGE_SORTS,
  type AccountBookingPageSettings,
} from "@vayada/domain-booking/account-booking-page";
import { SHARED_PROPERTY_TYPE_OPTIONS } from "@vayada/domain-hotels";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import {
  contactValue,
  filterSplit,
  includeAllReady,
  moveIncluded,
  orderedProperties,
  propertyStatus,
  setIncluded,
  type AccountBookingPageDraft,
  type DraftProblem,
  type PropertyStatus,
} from "@/lib/utils/accountBookingPage";
import type {
  AccountBookingPageProperty,
  AccountBookingPageSummary,
} from "@/services/api/accountBookingPageClient";

type Translate = (key: string, values?: Record<string, string | number>) => string;

export type SectionProps = {
  t: Translate;
  draft: AccountBookingPageDraft;
  setDraft: (next: AccountBookingPageDraft) => void;
  summary: AccountBookingPageSummary;
  /** Shown once the member tried to save. */
  problems: Set<DraftProblem>;
  disabled: boolean;
  /** The agency page's address around the slug, and the full one while the slug is valid. */
  address: { before: string; after: string; url: string | null };
  copyText: (value: string) => Promise<void>;
};

const KNOWN_TYPES = new Set<string>(SHARED_PROPERTY_TYPE_OPTIONS.map((option) => option.value));
const typeLabel = (t: Translate, type: string) =>
  KNOWN_TYPES.has(type) ? t(`settings.multiProperty.type.${type}`) : type;
const inputClass =
  "min-h-[44px] w-full rounded-lg border border-gray-300 bg-white px-3 text-[14px] font-normal text-gray-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/30 disabled:bg-gray-50";
const STATUS_STYLE: Record<PropertyStatus, string> = {
  live: "bg-green-50 text-green-800",
  hidden: "bg-gray-100 text-gray-600",
  notSetUp: "bg-amber-50 text-amber-800",
  noType: "bg-amber-50 text-amber-800",
  noLocation: "bg-amber-50 text-amber-800",
  noTypeNoLocation: "bg-amber-50 text-amber-800",
};

function Section({
  id,
  title,
  hint,
  aside,
  children,
}: {
  id: string;
  title: string;
  hint?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      id={`mp-${id}`}
      aria-labelledby={`mp-${id}-title`}
      className="flex scroll-mt-6 flex-col gap-4 rounded-2xl border border-gray-200 bg-white p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-[1_1_16rem]">
          <h2 id={`mp-${id}-title`} className="text-[17px] font-semibold text-gray-900">
            {title}
          </h2>
          {hint && <div className="mt-0.5 text-[14px] text-gray-500">{hint}</div>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Switches in one bordered list, each with its label and what it does. */
function Switches({
  rows,
  disabled,
}: {
  rows: { label: string; description: string; enabled: boolean; toggle: () => void }[];
  disabled: boolean;
}) {
  return (
    <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 px-4">
      {rows.map((row) => (
        <ToggleSwitch
          key={row.label}
          enabled={row.enabled}
          onChange={row.toggle}
          label={row.label}
          description={row.description}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: (describedBy: string | undefined) => React.ReactNode;
}) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ");
  return (
    <label className="flex min-w-0 flex-[1_1_16rem] flex-col gap-1.5 text-[14px] font-semibold text-gray-900">
      {label}
      {hint && (
        <span id={`${id}-hint`} className="font-normal text-gray-500">
          {hint}
        </span>
      )}
      {children(describedBy || undefined)}
      {error && (
        <span id={`${id}-error`} className="font-normal text-red-700">
          {error}
        </span>
      )}
    </label>
  );
}

const withSettings = (
  draft: AccountBookingPageDraft,
  change: (settings: AccountBookingPageSettings) => AccountBookingPageSettings,
): AccountBookingPageDraft => ({ ...draft, settings: change(draft.settings) });

export function PageSection({
  t,
  draft,
  setDraft,
  problems,
  disabled,
  address,
  copyText,
}: SectionProps) {
  const [copied, setCopied] = useState(false);
  const page = draft.settings.page;
  const setPage = (change: Partial<AccountBookingPageSettings["page"]>) =>
    setDraft(withSettings(draft, (s) => ({ ...s, page: { ...s.page, ...change } })));
  const titleError = problems.has("titleRequired")
    ? t("settings.multiProperty.error.titleRequired")
    : problems.has("titleTooLong")
      ? t("settings.multiProperty.error.titleTooLong")
      : null;
  return (
    <Section
      id="page"
      title={t("settings.multiProperty.nav.page")}
      hint={
        <span data-testid="multi-property-status">
          {draft.live && address.url
            ? t("settings.multiProperty.page.statusLive", {
                address: address.url.replace(/^https?:\/\//, ""),
              })
            : t("settings.multiProperty.page.statusOff")}
        </span>
      }
      aside={
        <button
          type="button"
          role="switch"
          aria-checked={draft.live}
          aria-label={t("settings.multiProperty.page.live")}
          disabled={disabled}
          onClick={() => setDraft({ ...draft, live: !draft.live })}
          className={`relative mt-1 h-[30px] w-[52px] shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:opacity-60 ${
            draft.live ? "bg-primary-500" : "bg-gray-300"
          }`}
        >
          <span
            className={`absolute top-[3px] h-6 w-6 rounded-full bg-white shadow transition-all ${
              draft.live ? "left-[25px]" : "left-[3px]"
            }`}
          />
        </button>
      }
    >
      <Field
        label={t("settings.multiProperty.page.titleLabel")}
        hint={t("settings.multiProperty.page.titleHint")}
        error={titleError}
      >
        {(describedBy) => (
          <input
            type="text"
            value={page.title}
            maxLength={120}
            disabled={disabled}
            aria-invalid={!!titleError}
            aria-describedby={describedBy}
            onChange={(event) => setPage({ title: event.target.value })}
            className={inputClass}
          />
        )}
      </Field>
      <Field
        label={t("settings.multiProperty.page.descriptionLabel")}
        hint={t("settings.multiProperty.page.descriptionHint")}
        error={
          problems.has("descriptionTooLong")
            ? t("settings.multiProperty.error.descriptionTooLong")
            : null
        }
      >
        {(describedBy) => (
          <textarea
            rows={2}
            value={page.description}
            disabled={disabled}
            aria-describedby={describedBy}
            // One line: guests and link previews show it as one.
            onChange={(event) =>
              setPage({ description: event.target.value.replace(/\s*\n\s*/g, " ") })
            }
            className={`${inputClass} resize-y py-2.5`}
          />
        )}
      </Field>
      <Field
        label={t("settings.multiProperty.page.link")}
        hint={t("settings.multiProperty.page.linkHint")}
        error={problems.has("invalidSlug") ? t("settings.multiProperty.error.invalidSlug") : null}
      >
        {(describedBy) => (
          <span className="flex flex-wrap items-stretch gap-2">
            <span className="flex min-h-[44px] min-w-0 flex-[1_1_16rem] items-stretch overflow-hidden rounded-lg border border-gray-300 font-normal focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500/30">
              {address.before.replace(/^https?:\/\//, "") && (
                <span className="flex items-center bg-gray-50 px-2.5 text-[13px] text-gray-500">
                  {address.before.replace(/^https?:\/\//, "")}
                </span>
              )}
              <input
                type="text"
                value={draft.slug}
                disabled={disabled}
                aria-label={t("settings.multiProperty.page.linkSlug")}
                aria-describedby={describedBy}
                aria-invalid={problems.has("invalidSlug")}
                autoCapitalize="off"
                spellCheck={false}
                onChange={(event) => setDraft({ ...draft, slug: event.target.value.toLowerCase() })}
                className="min-w-0 flex-1 border-0 px-2.5 text-[14px] text-gray-900 focus:outline-none focus:ring-0"
              />
              <span className="flex items-center bg-gray-50 px-2.5 text-[13px] text-gray-500">
                {address.after}
              </span>
            </span>
            <button
              type="button"
              disabled={!address.url}
              onClick={() => {
                if (!address.url) return;
                void copyText(address.url).then(() => setCopied(true));
              }}
              className="min-h-[44px] shrink-0 rounded-full border border-gray-300 bg-white px-4 text-[14px] font-semibold text-gray-900 hover:border-gray-500 disabled:opacity-50"
            >
              {t("settings.multiProperty.page.copy")}
            </button>
          </span>
        )}
      </Field>
      <p className="sr-only" aria-live="polite">
        {copied ? t("settings.multiProperty.page.copied") : ""}
      </p>
    </Section>
  );
}

export function HeaderSection({ t, draft, setDraft, summary, problems, disabled }: SectionProps) {
  const header = draft.settings.header;
  const setHeader = (change: Partial<AccountBookingPageSettings["header"]>) =>
    setDraft(withSettings(draft, (s) => ({ ...s, header: { ...s.header, ...change } })));
  const included = orderedProperties(summary.properties, draft.propertyIds).filter((property) =>
    draft.propertyIds.includes(property.propertyId),
  );
  const design = included.find((property) => property.propertyId === header.designPropertyId);
  const photo = (design ?? included[0])?.photoUrl ?? null;
  const switches = (["gallery", "contact", "language", "currency"] as const).map((key) => ({
    label: t(`settings.multiProperty.header.${key}`),
    description: t(`settings.multiProperty.header.${key}Hint`),
    enabled: header[key],
    toggle: () => setHeader({ [key]: !header[key] }),
  }));
  return (
    <Section
      id="header"
      title={t("settings.multiProperty.nav.header")}
      hint={t("settings.multiProperty.header.hint")}
    >
      <div className="flex flex-wrap items-center gap-4">
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element -- a stay's photo on its own CDN.
          <img
            src={photo}
            alt={t("settings.multiProperty.header.imageAlt")}
            className="h-[110px] w-[200px] rounded-xl object-cover"
          />
        ) : (
          <span className="h-[110px] w-[200px] rounded-xl bg-gray-100" aria-hidden="true" />
        )}
        <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-1">
          <strong className="text-[14px] text-gray-900">
            {t("settings.multiProperty.header.image")}
          </strong>
          <span className="text-[13px] text-gray-500">
            {t("settings.multiProperty.header.imageDefault")}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-4">
        <Field label={t("settings.multiProperty.header.topLeft")}>
          {() => (
            <select
              value={header.topLeft}
              disabled={disabled}
              onChange={(event) => setHeader({ topLeft: event.target.value as "name" | "logo" })}
              className={inputClass}
            >
              <option value="name">
                {t("settings.multiProperty.header.topLeftName", {
                  name: summary.defaults.page.title,
                })}
              </option>
              <option value="logo">{t("settings.multiProperty.header.topLeftLogo")}</option>
            </select>
          )}
        </Field>
        <Field label={t("settings.multiProperty.header.design")}>
          {() => (
            <select
              value={header.designPropertyId ?? ""}
              disabled={disabled}
              onChange={(event) => setHeader({ designPropertyId: event.target.value || null })}
              className={inputClass}
            >
              <option value="">{t("settings.multiProperty.header.designFirst")}</option>
              {included.map((property) => (
                <option key={property.propertyId} value={property.propertyId}>
                  {t("settings.multiProperty.header.designFrom", { name: property.name })}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Switches rows={switches} disabled={disabled} />
      {header.contact && (
        <div className="flex flex-wrap gap-4">
          <Field
            label={t("settings.multiProperty.header.contactEmail")}
            error={
              problems.has("invalidEmail")
                ? t("settings.multiProperty.error.invalidEmail")
                : problems.has("contactNeeded")
                  ? t("settings.multiProperty.error.contactNeeded")
                  : null
            }
          >
            {(describedBy) => (
              <input
                type="email"
                value={header.contactEmail ?? ""}
                disabled={disabled}
                autoComplete="email"
                aria-describedby={describedBy}
                aria-invalid={problems.has("invalidEmail") || problems.has("contactNeeded")}
                onChange={(event) =>
                  setHeader({ contactEmail: contactValue(event.target.value, "email") })
                }
                className={inputClass}
              />
            )}
          </Field>
          <Field
            label={t("settings.multiProperty.header.whatsapp")}
            hint={t("settings.multiProperty.header.whatsappHint")}
            error={
              problems.has("invalidWhatsapp")
                ? t("settings.multiProperty.error.invalidWhatsapp")
                : null
            }
          >
            {(describedBy) => (
              <input
                type="tel"
                value={header.contactWhatsapp ?? ""}
                disabled={disabled}
                autoComplete="tel"
                aria-describedby={describedBy}
                aria-invalid={problems.has("invalidWhatsapp")}
                onChange={(event) =>
                  setHeader({ contactWhatsapp: contactValue(event.target.value, "whatsapp") })
                }
                className={inputClass}
              />
            )}
          </Field>
        </div>
      )}
    </Section>
  );
}

export function PropertiesSection({ t, draft, setDraft, summary, disabled }: SectionProps) {
  const [announcement, setAnnouncement] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const rows = orderedProperties(summary.properties, draft.propertyIds);
  const total = draft.propertyIds.length;
  const move = (property: AccountBookingPageProperty, to: number) => {
    const propertyIds = moveIncluded(draft.propertyIds, property.propertyId, to);
    if (propertyIds.join() === draft.propertyIds.join()) return;
    setDraft({ ...draft, propertyIds });
    setAnnouncement(
      t("settings.multiProperty.properties.moved", {
        name: property.name,
        position: to + 1,
        total,
      }),
    );
  };
  const meta = (property: AccountBookingPageProperty) =>
    [
      property.propertyType
        ? typeLabel(t, property.propertyType)
        : t("settings.multiProperty.properties.typeMissing"),
      property.units === 1
        ? t("settings.multiProperty.properties.unitsOne")
        : property.units > 1
          ? t("settings.multiProperty.properties.units", { count: property.units })
          : null,
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <Section
      id="properties"
      title={t("settings.multiProperty.nav.properties")}
      hint={t("settings.multiProperty.properties.count", {
        included: total,
        total: summary.properties.length,
      })}
      aside={
        <button
          type="button"
          disabled={disabled}
          onClick={() => setDraft(includeAllReady(draft, summary.properties))}
          className="min-h-[44px] px-1 text-[14px] font-semibold text-gray-900 underline underline-offset-2 hover:text-gray-600 disabled:opacity-50"
        >
          {t("settings.multiProperty.properties.includeAll")}
        </button>
      }
    >
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200">
        {rows.map((property) => {
          const index = draft.propertyIds.indexOf(property.propertyId);
          const included = index >= 0;
          const status = propertyStatus(property, included);
          // A stay that isn't ready can't join; one included earlier can still leave.
          const locked = disabled || (!included && !property.ready);
          return (
            <li
              key={property.propertyId}
              data-testid={`multi-property-row-${property.propertyId}`}
              onDragOver={(event) => {
                if (!dragging || !included) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                const moved = rows.find((row) => row.propertyId === dragging);
                if (moved && included) move(moved, index);
                setDragging(null);
              }}
              className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-2 py-2 sm:flex-nowrap sm:px-3 ${
                dragging === property.propertyId ? "bg-gray-50" : ""
              }`}
            >
              <div className="flex shrink-0 items-center">
                <span
                  aria-hidden="true"
                  draggable={included && !disabled}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", property.propertyId);
                    setDragging(property.propertyId);
                  }}
                  onDragEnd={() => setDragging(null)}
                  className={`flex h-11 w-5 items-center justify-center text-gray-400 ${
                    included && !disabled ? "cursor-grab hover:text-gray-600" : "invisible"
                  }`}
                >
                  <EllipsisVerticalIcon className="h-5 w-5" />
                </span>
                <div className={`flex flex-col ${included ? "" : "invisible"}`}>
                  {(
                    [
                      [-1, "settings.multiProperty.properties.moveUp", ChevronUpIcon],
                      [1, "settings.multiProperty.properties.moveDown", ChevronDownIcon],
                    ] as const
                  ).map(([step, label, Icon]) => (
                    <button
                      key={step}
                      type="button"
                      aria-label={t(label, { name: property.name })}
                      disabled={!included || disabled || index + step < 0 || index + step >= total}
                      onClick={() => move(property, index + step)}
                      className="flex h-[22px] w-8 items-center justify-center rounded text-gray-400 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-30"
                    >
                      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
              {property.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a stay's photo on its own CDN.
                <img
                  src={property.photoUrl}
                  alt=""
                  className="h-[42px] w-14 shrink-0 rounded-lg object-cover"
                />
              ) : (
                <span
                  className="h-[42px] w-14 shrink-0 rounded-lg bg-gray-100"
                  aria-hidden="true"
                />
              )}
              <span className="flex min-w-0 flex-[1_1_8rem] flex-col">
                <strong className="truncate text-[14px] text-gray-900">{property.name}</strong>
                <span className="text-[13px] text-gray-500">{meta(property)}</span>
              </span>
              <span
                data-testid="multi-property-status-pill"
                className={`shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${STATUS_STYLE[status]}`}
              >
                {t(`settings.multiProperty.status.${status}`)}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={included}
                aria-label={t("settings.multiProperty.properties.include", { name: property.name })}
                disabled={locked}
                onClick={() => setDraft(setIncluded(draft, property.propertyId, !included))}
                className={`relative h-[26px] w-11 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45 ${
                  included ? "bg-primary-500" : "bg-gray-300"
                }`}
              >
                <span
                  className={`absolute top-[3px] h-5 w-5 rounded-full bg-white shadow transition-all ${
                    included ? "left-[21px]" : "left-[3px]"
                  }`}
                />
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-[13px] text-gray-500">{t("settings.multiProperty.properties.hint")}</p>
    </Section>
  );
}

export function LayoutSection({ t, draft, setDraft, summary, disabled }: SectionProps) {
  const layout = draft.settings.layout;
  const setLayout = (next: AccountBookingPageSettings["layout"]) =>
    setDraft(withSettings(draft, (s) => ({ ...s, layout: next })));
  const toggle = (key: (typeof ACCOUNT_BOOKING_PAGE_LAYOUTS)[number]) => {
    if (key === "list") return;
    const allowed = ACCOUNT_BOOKING_PAGE_LAYOUTS.filter((item) =>
      item === key ? !layout.allowed.includes(key) : layout.allowed.includes(item),
    );
    setLayout({ allowed, default: allowed.includes(layout.default) ? layout.default : "list" });
  };
  const usesMap =
    layout.allowed.includes("split") ||
    layout.allowed.includes("map") ||
    draft.settings.stayPage.map;
  const unlocated = orderedProperties(summary.properties, draft.propertyIds)
    .filter((p) => draft.propertyIds.includes(p.propertyId) && p.missing.includes("location"))
    .map((p) => p.name);
  return (
    <Section
      id="layout"
      title={t("settings.multiProperty.nav.layout")}
      hint={t("settings.multiProperty.layout.hint")}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[14px] font-semibold text-gray-900">
          {t("settings.multiProperty.layout.allowed")}
        </legend>
        <div className="flex flex-wrap gap-2">
          {ACCOUNT_BOOKING_PAGE_LAYOUTS.map((key) => {
            const on = layout.allowed.includes(key);
            return (
              <label
                key={key}
                className={`flex min-w-0 flex-[1_1_12rem] cursor-pointer items-start gap-2.5 rounded-xl border px-3.5 py-3 ${
                  on ? "border-2 border-primary-500" : "border-gray-300"
                } ${key === "list" ? "cursor-default" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={disabled || key === "list"}
                  onChange={() => toggle(key)}
                  className="mt-0.5 h-5 w-5 shrink-0 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <strong className="text-[14px] text-gray-900">
                    {t(`settings.multiProperty.layout.${key}`)}
                  </strong>
                  <span className="text-[13px] text-gray-500">
                    {t(`settings.multiProperty.layout.${key}Hint`)}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <label className="flex flex-wrap items-center justify-between gap-3 text-[14px] font-semibold text-gray-900">
        {t("settings.multiProperty.layout.default")}
        <select
          value={layout.default}
          disabled={disabled}
          onChange={(event) =>
            setLayout({ ...layout, default: event.target.value as typeof layout.default })
          }
          className={`${inputClass} sm:w-60`}
        >
          {layout.allowed.map((key) => (
            <option key={key} value={key}>
              {t(`settings.multiProperty.layout.${key}`)}
            </option>
          ))}
        </select>
      </label>
      <p className="-mt-2 text-[13px] text-gray-500">
        {t("settings.multiProperty.layout.defaultHint")}
      </p>
      {usesMap && unlocated.length > 0 && (
        <p
          role="note"
          data-testid="multi-property-map-warning"
          className="rounded-lg bg-amber-50 px-3 py-2.5 text-[13px] text-amber-800"
        >
          {t("settings.multiProperty.layout.noLocation", { names: unlocated.join(", ") })}
        </p>
      )}
    </Section>
  );
}

export function ResultsSection({ t, draft, setDraft, disabled }: SectionProps) {
  const results = draft.settings.results;
  const setResults = (change: Partial<AccountBookingPageSettings["results"]>) =>
    setDraft(withSettings(draft, (s) => ({ ...s, results: { ...s.results, ...change } })));
  return (
    <Section id="results" title={t("settings.multiProperty.nav.results")}>
      <label className="flex flex-wrap items-center justify-between gap-3 text-[14px] font-semibold text-gray-900">
        {t("settings.multiProperty.results.defaultSort")}
        <select
          value={results.defaultSort}
          disabled={disabled}
          onChange={(event) =>
            setResults({ defaultSort: event.target.value as typeof results.defaultSort })
          }
          className={`${inputClass} sm:w-72`}
        >
          {ACCOUNT_BOOKING_PAGE_SORTS.map((key) => (
            <option key={key} value={key}>
              {t(`settings.multiProperty.results.sort.${key}`)}
            </option>
          ))}
        </select>
      </label>
      <Switches
        disabled={disabled}
        rows={(["lowestPriceBadge", "showFullStays"] as const).map((key) => ({
          label: t(`settings.multiProperty.results.${key}`),
          description: t(`settings.multiProperty.results.${key}Hint`),
          enabled: results[key],
          toggle: () => setResults({ [key]: !results[key] }),
        }))}
      />
    </Section>
  );
}

export function FiltersSection({ t, draft, setDraft, summary, disabled }: SectionProps) {
  const filters = draft.settings.filters;
  const included = summary.properties.filter((p) => draft.propertyIds.includes(p.propertyId));
  const rows = ACCOUNT_BOOKING_PAGE_FILTERS.map((key) => {
    const split = filterSplit(key, included);
    const description =
      (key === "propertyType" || key === "area") && filters[key]
        ? split.splits
          ? t("settings.multiProperty.filters.fromEach", {
              values: (key === "propertyType"
                ? split.values.map((type) => typeLabel(t, type))
                : split.values
              ).join(", "),
            })
          : t(`settings.multiProperty.filters.${key}Same`)
        : t(`settings.multiProperty.filters.${key}Hint`);
    return { key, split, description };
  });
  const shown = rows
    .filter((row) => filters[row.key] && row.split.splits)
    .map((row) => t(`settings.multiProperty.filters.${row.key}`));
  return (
    <Section
      id="filters"
      title={t("settings.multiProperty.nav.filters")}
      hint={t("settings.multiProperty.filters.hint")}
    >
      <Switches
        disabled={disabled}
        rows={rows.map((row) => ({
          label: t(`settings.multiProperty.filters.${row.key}`),
          description: row.description,
          enabled: filters[row.key],
          toggle: () =>
            setDraft(
              withSettings(draft, (s) => ({
                ...s,
                filters: { ...s.filters, [row.key]: !s.filters[row.key] },
              })),
            ),
        }))}
      />
      <p data-testid="multi-property-chips" className="text-[13px] text-gray-500">
        {t("settings.multiProperty.filters.shown", {
          chips: shown.length ? shown.join(" · ") : t("settings.multiProperty.filters.none"),
        })}
      </p>
    </Section>
  );
}

export function StayPageSection({ t, draft, setDraft, disabled }: SectionProps) {
  const stayPage = draft.settings.stayPage;
  return (
    <Section
      id="stay"
      title={t("settings.multiProperty.nav.stayPage")}
      hint={t("settings.multiProperty.stayPage.hint")}
    >
      <Switches
        disabled={disabled}
        rows={(["nearby", "map"] as const).map((key) => ({
          label: t(`settings.multiProperty.stayPage.${key}`),
          description: t(`settings.multiProperty.stayPage.${key}Hint`),
          enabled: stayPage[key],
          toggle: () =>
            setDraft(
              withSettings(draft, (s) => ({
                ...s,
                stayPage: { ...s.stayPage, [key]: !s.stayPage[key] },
              })),
            ),
        }))}
      />
    </Section>
  );
}
