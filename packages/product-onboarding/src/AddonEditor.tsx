"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  GuestAddonCard,
  GuestAddonDetail,
  formatGuestPrice,
  guestAddonAddClass,
  guestAddonCategories,
  guestAddonPrimaryClass,
  guestAddonText,
  guestAddonUnit,
} from "./GuestAddon";

export type AddonPhoto = {
  imageUrl: string;
  mediaObjectId: string | null;
  isCover: boolean;
  file?: File;
};
export type AddonEditorValues = {
  name: string;
  description: string;
  price: string;
  currency: string;
  category: "experience" | "dining" | "wellness" | "transport" | "other";
  duration: string;
  location: string;
  maxGuests: string;
  /** VAY-2232: the notice guests must give, in hours ("" for none). */
  leadTimeHours: "" | `${AddonLeadTimeHours}`;
  /** A lead time typed as free text before the fixed choices; kept until one is chosen. */
  legacyLeadTime: string;
  maxQuantity: string;
  perPerson: boolean;
  perNight: boolean;
  photos: AddonPhoto[];
  ownershipKind: "property" | "partner";
  partnerCommissionRate: string;
};
export function emptyAddonValues(currency: string): AddonEditorValues {
  return {
    name: "",
    description: "",
    price: "",
    currency,
    category: "experience",
    duration: "",
    location: "",
    maxGuests: "",
    leadTimeHours: "",
    legacyLeadTime: "",
    maxQuantity: "1",
    perPerson: false,
    perNight: false,
    photos: [],
    ownershipKind: "property",
    partnerCommissionRate: "",
  };
}
// [label, description, perPerson, perNight, price label]
const models = [
  [
    "addons.editor.flatFee",
    "addons.editor.fixedPricePerBooking",
    false,
    false,
    "addons.editor.pricePerBooking",
  ],
  [
    "addons.editor.perPerson",
    "addons.editor.baseNumberOfGuests",
    true,
    false,
    "addons.editor.pricePerGuest",
  ],
  [
    "addons.editor.perNight",
    "addons.editor.baseNumberOfNights",
    false,
    true,
    "addons.editor.pricePerNight",
  ],
  [
    "addons.editor.perPersonNight",
    "addons.editor.baseGuestsNights",
    true,
    true,
    "addons.editor.pricePerGuestNight",
  ],
] as const;
/** The add-on categories, in the order the editor and the Add-ons filter chips show them. */
export const ADDON_CATEGORIES = ["dining", "transport", "wellness", "experience", "other"] as const;
/** VAY-2232: the lead times a host can pick (the API accepts exactly these), with the option's
 * label and the notice guests see. */
export const addonLeadTimes = [
  [12, "addons.editor.leadTime12h", "addons.editor.needs12hNotice"],
  [24, "addons.editor.leadTime24h", "addons.editor.needs24hNotice"],
  [48, "addons.editor.leadTime2d", "addons.editor.needs2dNotice"],
  [72, "addons.editor.leadTime3d", "addons.editor.needs3dNotice"],
  [168, "addons.editor.leadTime1w", "addons.editor.needs1wNotice"],
] as const;
export type AddonLeadTimeHours = (typeof addonLeadTimes)[number][0];
/** The "Needs 24 hours' notice" message key for a lead time, or null for none. */
export function addonLeadTimeNoticeKey(hours: number | string | null | undefined) {
  return addonLeadTimes.find(([value]) => String(value) === String(hours))?.[2] ?? null;
}
// Fields under "More options"; opened when they hold values or have errors.
const optionalFields = [
  "maxQuantity",
  "duration",
  "leadTimeHours",
  "location",
  "maxGuests",
  "partnerCommissionRate",
] as const;
const inputClass =
  "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500";

/** VAY-2231: what the booking page shows for these values: the card's and the details' props. */
export function addonGuestView(
  values: AddonEditorValues,
  currency: string,
  t: (key: string) => string,
) {
  const cover = values.photos.find((photo) => photo.isCover) ?? values.photos[0];
  const notice = addonLeadTimeNoticeKey(values.leadTimeHours);
  const guests = /^\d+$/.test(values.maxGuests) ? Number(values.maxGuests) : 0;
  return {
    name: values.name.trim() || t("addons.editor.untitledAddOn"),
    description: values.description.trim(),
    category: guestAddonCategories[values.category],
    // The cover first, as the booking page orders them.
    photos: cover
      ? [cover, ...values.photos.filter((photo) => photo !== cover)].map((photo) => photo.imageUrl)
      : [],
    facts: {
      duration: values.duration.trim() || null,
      location: values.location.trim() || null,
      guests: guests >= 1 ? guestAddonText.upToGuests(guests) : null,
      notice: notice ? t(notice) : null,
    },
    price: formatGuestPrice(
      /^\d+(?:\.\d{1,2})?$/.test(values.price) ? Number(values.price) : 0,
      currency,
    ),
    unit: guestAddonUnit(values.perPerson, values.perNight),
  };
}

function formatPrice(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

type Translate = (key: string, params?: Record<string, string | number>) => string;
const englishText: Translate = (key, params) => {
  let message = AddonEditorMessages[key as keyof typeof AddonEditorMessages];
  for (const [name, value] of Object.entries(params ?? {}))
    message = message.split(`{${name}}`).join(String(value));
  return message;
};

/** VAY-2231: the add-on's details as guests see them, from the Add-ons list's eye button. */
export function AddonGuestPreview({
  translate,
  values,
  currency,
  onEdit,
  onClose,
}: {
  translate?: Translate;
  values: AddonEditorValues;
  currency: string;
  /** Left out while the add-on can't be edited (no property currency). */
  onEdit?: () => void;
  onClose: () => void;
}) {
  const t = translate ?? englishText;
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal?.();
  }, []);
  const view = addonGuestView(values, currency, t);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="addon-guest-preview-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-auto max-h-[90vh] w-[calc(100%-2rem)] max-w-[776px] overflow-hidden rounded-2xl bg-white p-0 text-gray-900 shadow-2xl backdrop:bg-black/40 open:flex open:flex-col"
    >
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-gray-200 px-6 py-5">
        <div>
          <h2 id="addon-guest-preview-title" className="text-lg font-semibold">
            {t("addons.preview.title", { name: view.name })}
          </h2>
          <p className="mt-1 text-sm text-gray-500">{t("addons.preview.subtitle")}</p>
        </div>
        <button
          type="button"
          aria-label={t("addons.preview.close")}
          onClick={onClose}
          className="rounded-lg p-1.5 text-xl leading-none text-gray-500 hover:bg-gray-100 hover:text-gray-900"
        >
          ×
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto bg-gray-100 px-4 py-6 md:px-12">
        <div className="mx-auto flex max-w-[680px] flex-col overflow-hidden rounded-[20px] bg-white shadow-xl">
          <GuestAddonDetail
            {...view}
            action={<span className={guestAddonPrimaryClass}>{guestAddonText.add}</span>}
          />
        </div>
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-gray-200 px-6 py-4">
        <p className="text-[13px] text-gray-500">{t("addons.preview.inert")}</p>
        <div className="flex gap-2">
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
            >
              {t("addons.editor.editAddOn")}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700"
          >
            {t("addons.preview.done")}
          </button>
        </div>
      </footer>
    </dialog>
  );
}

export function AddonEditor({
  translate,
  initialValues,
  currency,
  editing,
  onSave,
  onCancel,
}: {
  translate?: Translate;
  initialValues: AddonEditorValues;
  currency: string;
  editing: boolean;
  onSave: (values: AddonEditorValues) => Promise<void> | void;
  onCancel: () => void;
}) {
  const t = translate ?? englishText;
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [moreOpen, setMoreOpen] = useState(
    initialValues.ownershipKind === "partner" ||
      ["duration", "leadTimeHours", "location", "maxGuests"].some(
        (key) => initialValues[key as keyof AddonEditorValues],
      ) ||
      initialValues.maxQuantity !== "1",
  );
  const dialog = useRef<HTMLDialogElement>(null);
  const previews = useRef<string[]>([]);
  useEffect(() => {
    dialog.current?.showModal();
    return () => previews.current.forEach(URL.revokeObjectURL);
  }, []);
  const model =
    models.find(
      ([, , perPerson, perNight]) => values.perPerson === perPerson && values.perNight === perNight,
    ) ?? models[0];
  const price = /^\d+(?:\.\d{1,2})?$/.test(values.price) ? Number(values.price) : 0;
  const view = addonGuestView(values, currency, t);
  const [previewTab, setPreviewTab] = useState<"list" | "detail">("list");
  function field(key: keyof AddonEditorValues, label: string, type = "text", placeholder = "") {
    return (
      <label className="block text-xs font-medium text-gray-800">
        {label}
        <input
          type={type}
          value={String(values[key])}
          placeholder={placeholder}
          min={type === "number" ? 1 : undefined}
          step={type === "number" ? 1 : undefined}
          onChange={(e) => {
            setValues((v) => ({ ...v, [key]: e.target.value }));
            setErrors((v) => ({ ...v, [key]: "" }));
          }}
          aria-label={label}
          aria-describedby={errors[key] ? `addon-error-${key}` : undefined}
          aria-invalid={Boolean(errors[key])}
          className={inputClass}
        />
        {errors[key] && (
          <span id={`addon-error-${key}`} role="alert" className="mt-1 block text-red-600">
            {t(errors[key])}
          </span>
        )}
      </label>
    );
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const next: Record<string, string> = {};
    if (!values.name.trim()) next.name = "addons.editor.nameIsRequired";
    if (!/^\d+(?:\.\d{1,2})?$/.test(values.price))
      next.price = "addons.editor.enterANonNegativeBasePriceWithUpToTwo";
    for (const key of ["maxQuantity", "maxGuests"] as const) {
      if (
        (key === "maxQuantity" || values[key]) &&
        (!/^\d+$/.test(values[key]) ||
          !Number.isSafeInteger(Number(values[key])) ||
          Number(values[key]) < 1)
      )
        next[key] = "addons.editor.enterAPositiveWholeNumber";
    }
    if (
      values.ownershipKind === "partner" &&
      !/^(?:100(?:\.0{1,4})?|(?:0|[1-9]\d?)(?:\.\d{1,4})?)$/.test(values.partnerCommissionRate)
    )
      next.partnerCommissionRate = "addons.editor.enterACommissionFrom0To100WithUpTo";
    if (!currency) next.save = "addons.editor.propertyCurrencyIsUnavailablePleaseReload";
    setErrors(next);
    if (optionalFields.some((key) => next[key])) setMoreOpen(true);
    if (Object.keys(next).length) return;
    setSaving(true);
    try {
      await onSave({ ...values, name: values.name.trim(), currency });
    } catch {
      setErrors({
        save: "addons.editor.couldNotSaveAddOnPleaseRetry",
      });
    } finally {
      setSaving(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      aria-labelledby="addon-editor-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onCancel();
      }}
      className="m-auto max-h-[90vh] w-[calc(100%-2rem)] max-w-5xl overflow-hidden rounded-2xl bg-white p-0 text-gray-900 shadow-2xl backdrop:bg-black/40"
    >
      <form onSubmit={save} noValidate className="flex max-h-[90vh] flex-col">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-gray-200 px-6 py-5">
          <div>
            <h2 id="addon-editor-title" className="text-lg font-semibold">
              {editing ? t("addons.editor.editAddOn") : t("addons.editor.newAddOn")}
            </h2>
            <p className="mt-1 text-sm text-gray-500">{t("addons.editor.essentialsHint")}</p>
          </div>
          <button
            type="button"
            aria-label={t("addons.editor.closeAddOnEditor")}
            onClick={() => !saving && onCancel()}
            className="rounded-lg p-1.5 text-xl leading-none text-gray-500 hover:bg-gray-100 hover:text-gray-900"
          >
            ×
          </button>
        </header>
        <div className="grid min-h-0 overflow-y-auto md:grid-cols-[minmax(0,1fr)_22.5rem]">
          <section className="space-y-5 p-6">
            <h3 className="text-xs font-semibold tracking-widest text-gray-500">
              {t("addons.editor.essentials")}
            </h3>
            {field(
              "name",
              t("addons.editor.name"),
              "text",
              t("addons.editor.eGAirportTransferDailyBreakfast"),
            )}
            <fieldset>
              <legend className="mb-2 text-xs font-medium text-gray-800">
                {t("addons.editor.category")}
              </legend>
              <div className="flex flex-wrap gap-2">
                {ADDON_CATEGORIES.map((category) => (
                  <label
                    key={category}
                    className={`relative cursor-pointer rounded-full border px-3.5 py-1.5 text-sm focus-within:ring-2 focus-within:ring-primary-500 ${values.category === category ? "border-primary-500 bg-primary-50 text-primary-700" : "border-gray-200 text-gray-700 hover:border-gray-300"}`}
                  >
                    <input
                      type="radio"
                      name="addon-category"
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      checked={values.category === category}
                      onChange={() => setValues((v) => ({ ...v, category }))}
                    />
                    {t(`addons.category.${category}`)}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="block text-xs font-medium text-gray-800">
              {t("addons.editor.description")}
              <textarea
                value={values.description}
                rows={3}
                className={inputClass}
                placeholder={t("addons.editor.whatTheGuestGetsOneOrTwoSentences")}
                onChange={(e) => setValues((v) => ({ ...v, description: e.target.value }))}
              />
            </label>
            <div>
              <p className="mb-2 text-xs font-medium text-gray-800">
                {t("addons.editor.photos")}{" "}
                <span className="font-normal text-gray-500">{t("addons.editor.upTo5")}</span>
              </p>
              <div className="flex flex-wrap gap-2">
                {values.photos.map((photo, index) => (
                  <div key={photo.imageUrl} className="relative h-24 w-32">
                    <button
                      type="button"
                      aria-label={t("admin.setPhotoNumberAsCover", { number: index + 1 })}
                      aria-pressed={photo.isCover}
                      className="h-full w-full overflow-hidden rounded-xl border"
                      onClick={() =>
                        setValues((v) => ({
                          ...v,
                          photos: v.photos.map((p, i) => ({ ...p, isCover: i === index })),
                        }))
                      }
                    >
                      <img
                        src={photo.imageUrl}
                        alt={t("admin.addOnPhotoNumber", { number: index + 1 })}
                        className="h-full w-full object-cover"
                      />
                      {photo.isCover && (
                        <span className="absolute bottom-1 left-1 rounded bg-primary-600 px-1 text-[10px] text-white">
                          {t("addons.editor.cover")}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label={t("admin.removePhotoNumber", { number: index + 1 })}
                      className="absolute right-1 top-1 rounded bg-gray-900 px-1 text-white"
                      onClick={() =>
                        setValues((v) => {
                          const photos = v.photos.filter((_, i) => i !== index);
                          if (photos.length && !photos.some((p) => p.isCover))
                            photos[0] = { ...photos[0], isCover: true };
                          return { ...v, photos };
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
                {values.photos.length < 5 && (
                  <label className="flex h-24 w-32 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-gray-300 text-xs text-gray-500 hover:border-gray-400">
                    <span aria-hidden="true" className="text-lg leading-none">
                      +
                    </span>
                    <span>{t("addons.editor.addPhoto")}</span>
                    <input
                      type="file"
                      multiple
                      accept="image/jpeg,image/png,image/webp"
                      aria-label={t("addons.editor.addPhotos")}
                      className="sr-only"
                      onChange={(event) => {
                        const files = Array.from(event.target.files ?? []);
                        event.target.value = "";
                        if (files.length + values.photos.length > 5) {
                          setErrors((e) => ({
                            ...e,
                            photos: "addons.editor.photoLimit",
                          }));
                          return;
                        }
                        if (
                          files.some(
                            (file) =>
                              !["image/jpeg", "image/png", "image/webp"].includes(file.type),
                          )
                        ) {
                          setErrors((e) => ({ ...e, photos: "addons.editor.photoFormat" }));
                          return;
                        }
                        const added = files.map((file) => {
                          const imageUrl = URL.createObjectURL(file);
                          previews.current.push(imageUrl);
                          return { file, imageUrl, mediaObjectId: null, isCover: false };
                        });
                        setValues((v) => ({
                          ...v,
                          photos: [...v.photos, ...added].map((p, i) => ({
                            ...p,
                            isCover: v.photos.length ? p.isCover : i === 0,
                          })),
                        }));
                        setErrors((e) => ({ ...e, photos: "" }));
                      }}
                    />
                  </label>
                )}
              </div>
              <p className="mt-2 text-xs text-gray-500">{t("addons.editor.photoHint")}</p>
              {errors.photos && (
                <p role="alert" className="mt-1 text-xs text-red-600">
                  {t(errors.photos)}
                </p>
              )}
            </div>
            <fieldset>
              <legend className="mb-2 text-xs font-medium text-gray-800">
                {t("addons.editor.howIsItPriced")}
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {models.map(([label, description, perPerson, perNight]) => (
                  <label
                    key={label}
                    className={`relative cursor-pointer rounded-xl border p-3.5 text-sm focus-within:ring-2 focus-within:ring-primary-500 ${values.perPerson === perPerson && values.perNight === perNight ? "border-primary-500 bg-primary-50" : "border-gray-200 hover:border-gray-300"}`}
                  >
                    <input
                      type="radio"
                      name="addon-pricing-model"
                      aria-label={t(label)}
                      className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
                      checked={values.perPerson === perPerson && values.perNight === perNight}
                      onChange={() => setValues((v) => ({ ...v, perPerson, perNight }))}
                    />
                    <span className="block font-medium text-gray-900">{t(label)}</span>
                    <span className="mt-1 block text-xs text-gray-500">{t(description)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid items-end gap-3 sm:grid-cols-2">
              {field("price", t(model[4], { currency }), "text", "0.00")}
              <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
                {t("addons.editor.priceExample", {
                  total: formatPrice(
                    price * (values.perPerson ? 2 : 1) * (values.perNight ? 3 : 1),
                    currency,
                  ),
                })}
              </p>
            </div>
            <details
              open={moreOpen}
              onToggle={(event) => setMoreOpen(event.currentTarget.open)}
              className="rounded-xl border border-gray-200"
            >
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-800">
                {t("addons.editor.moreOptions")}
              </summary>
              <div className="space-y-4 border-t border-gray-200 p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  {field("maxQuantity", t("addons.editor.maxQuantity"), "number")}
                  {field(
                    "duration",
                    t("addons.editor.duration"),
                    "text",
                    t("addons.editor.eG2Hours"),
                  )}
                  <label className="block text-xs font-medium text-gray-800">
                    {t("addons.editor.leadTime")}
                    <select
                      value={values.leadTimeHours || (values.legacyLeadTime ? "typed" : "")}
                      aria-label={t("addons.editor.leadTime")}
                      className={inputClass}
                      onChange={(e) =>
                        setValues((v) => ({
                          ...v,
                          leadTimeHours: e.target.value as AddonEditorValues["leadTimeHours"],
                          // Any choice replaces text typed before the fixed choices.
                          legacyLeadTime: "",
                        }))
                      }
                    >
                      {values.legacyLeadTime && !values.leadTimeHours && (
                        <option value="typed" disabled>
                          {t("addons.editor.typedLeadTime", { text: values.legacyLeadTime })}
                        </option>
                      )}
                      <option value="">{t("addons.editor.noLeadTime")}</option>
                      {addonLeadTimes.map(([hours, label]) => (
                        <option key={hours} value={String(hours)}>
                          {t(label)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {field(
                    "location",
                    t("addons.editor.location"),
                    "text",
                    t("addons.editor.eGHotelLobby"),
                  )}
                  {field(
                    "maxGuests",
                    t("addons.editor.maxGuests"),
                    "number",
                    t("addons.editor.eG6"),
                  )}
                </div>
                <p className="text-xs text-gray-500">
                  {t("addons.editor.maxQuantityIsTheNumberOfPackagesPerBooking")}
                </p>
                <label className="block text-xs font-medium text-gray-800">
                  {t("addons.editor.ownership")}
                  <select
                    value={values.ownershipKind}
                    className={inputClass}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        ownershipKind: e.target.value as "property" | "partner",
                      }))
                    }
                  >
                    <option value="property">{t("addons.editor.own")}</option>
                    <option value="partner">{t("addons.editor.partner")}</option>
                  </select>
                </label>
                {values.ownershipKind === "partner" &&
                  field("partnerCommissionRate", t("addons.editor.partnerCommission"))}
              </div>
            </details>
          </section>
          <aside className="border-t border-gray-200 bg-gray-50 p-6 md:border-l md:border-t-0">
            {/* Keep the preview in view while the form scrolls. */}
            <div className="md:sticky md:top-0">
              <h3
                id="addon-guest-preview"
                className="text-xs font-semibold tracking-widest text-gray-500"
              >
                {t("addons.editor.guestPreview")}
              </h3>
              {/* VAY-2231: the booking page's own card and details. */}
              <div
                role="group"
                aria-labelledby="addon-guest-preview"
                className="mt-3 flex rounded-[10px] bg-gray-200 p-1"
              >
                {(
                  [
                    ["list", "addons.editor.previewCheckoutList"],
                    ["detail", "addons.editor.previewDetailView"],
                  ] as const
                ).map(([tab, label]) => (
                  <button
                    key={tab}
                    type="button"
                    aria-pressed={previewTab === tab}
                    onClick={() => setPreviewTab(tab)}
                    className={`flex-1 rounded-[7px] py-1.5 text-[13px] ${previewTab === tab ? "bg-white font-semibold text-gray-900 shadow-sm" : "font-medium text-gray-600 hover:text-gray-900"}`}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
              <div className="mt-3">
                {previewTab === "list" ? (
                  <GuestAddonCard
                    name={view.name}
                    description={view.description}
                    photo={view.photos[0] ?? null}
                    price={view.price}
                    unit={view.unit}
                    action={<span className={guestAddonAddClass}>{guestAddonText.add}</span>}
                    onOpenDetails={() => setPreviewTab("detail")}
                  />
                ) : (
                  <div className="flex flex-col overflow-hidden rounded-2xl border border-gray-200">
                    <GuestAddonDetail
                      {...view}
                      size="compact"
                      action={<span className={guestAddonPrimaryClass}>{guestAddonText.add}</span>}
                    />
                  </div>
                )}
              </div>
              <p className="mt-3 text-xs text-gray-500">
                {t(
                  previewTab === "list"
                    ? "addons.editor.previewListHint"
                    : "addons.editor.previewDetailHint",
                )}
              </p>
            </div>
          </aside>
        </div>
        <footer className="shrink-0 border-t border-gray-200 px-6 py-4">
          {errors.save && (
            <p role="alert" className="mb-3 text-sm text-red-600">
              {t(errors.save)}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => !saving && onCancel()}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
            >
              {t("addons.editor.cancel")}
            </button>
            <button
              type="submit"
              aria-busy={saving}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700"
            >
              {saving
                ? t("addons.editor.saving")
                : editing
                  ? t("addons.editor.save")
                  : t("addons.editor.createAddOn")}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}

export const AddonEditorMessages = {
  "addons.editor.photoLimit": "Choose up to five photos in total.",
  "addons.editor.photoFormat": "Choose JPEG, PNG, or WebP images.",
  "addons.category.other": "Other",
  "addons.category.transport": "Transport",
  "addons.category.wellness": "Wellness",
  "addons.category.dining": "Food & Beverage",
  "addons.category.experience": "Experiences",
  "admin.removePhotoNumber": "Remove photo {number}",
  "admin.addOnPhotoNumber": "Add-on photo {number}",
  "admin.setPhotoNumberAsCover": "Set photo {number} as cover",
  "addons.editor.flatFee": "Flat price",
  "addons.editor.fixedPricePerBooking": "One price per booking, no matter the stay.",
  "addons.editor.perPerson": "Per person",
  "addons.editor.baseNumberOfGuests": "Price × number of guests.",
  "addons.editor.perNight": "Per night",
  "addons.editor.baseNumberOfNights": "Price × number of nights.",
  "addons.editor.perPersonNight": "Per person × night",
  "addons.editor.baseGuestsNights": "Price × guests × nights.",
  "addons.editor.nameIsRequired": "Name is required.",
  "addons.editor.enterANonNegativeBasePriceWithUpToTwo":
    "Enter a non-negative base price with up to two decimals.",
  "addons.editor.enterAPositiveWholeNumber": "Enter a positive whole number.",
  "addons.editor.enterACommissionFrom0To100WithUpTo":
    "Enter a commission from 0 to 100 with up to four decimals.",
  "addons.editor.propertyCurrencyIsUnavailablePleaseReload":
    "Property currency is unavailable. Please reload.",
  "addons.editor.couldNotSaveAddOnPleaseRetry": "Could not save add-on. Please retry.",
  "addons.editor.editAddOn": "Edit add-on",
  "addons.editor.createAddOn": "Create add-on",
  "addons.editor.closeAddOnEditor": "Close add-on editor",
  "addons.editor.name": "Name *",
  "addons.editor.eGAirportTransferDailyBreakfast": "e.g., Airport Transfer, Daily Breakfast",
  "addons.editor.description": "Description",
  "addons.editor.whatTheGuestGetsOneOrTwoSentences": "What the guest gets, one or two sentences.",
  "addons.editor.category": "Category",
  "addons.editor.photos": "Photos",
  "addons.editor.upTo5": "Up to 5",
  "addons.editor.cover": "COVER",
  "addons.editor.addPhotos": "Add photos",
  "addons.editor.duration": "Duration",
  "addons.editor.eG2Hours": "e.g., 2 hours",
  "addons.editor.location": "Location",
  "addons.editor.eGHotelLobby": "e.g., Hotel lobby",
  "addons.editor.maxGuests": "Max guests",
  "addons.editor.eG6": "e.g., 6",
  "addons.editor.leadTime": "Lead time",
  "addons.editor.noLeadTime": "No lead time",
  "addons.editor.typedLeadTime": "{text} (typed earlier)",
  "addons.editor.leadTime12h": "12 hours",
  "addons.editor.leadTime24h": "24 hours",
  "addons.editor.leadTime2d": "2 days",
  "addons.editor.leadTime3d": "3 days",
  "addons.editor.leadTime1w": "1 week",
  "addons.editor.needs12hNotice": "Needs 12 hours’ notice",
  "addons.editor.needs24hNotice": "Needs 24 hours’ notice",
  "addons.editor.needs2dNotice": "Needs 2 days’ notice",
  "addons.editor.needs3dNotice": "Needs 3 days’ notice",
  "addons.editor.needs1wNotice": "Needs 1 week’s notice",
  "addons.editor.maxQuantity": "Max quantity",
  "addons.editor.maxQuantityIsTheNumberOfPackagesPerBooking":
    "Max quantity is the number of packages per booking.",
  "addons.editor.ownership": "Ownership",
  "addons.editor.own": "Own",
  "addons.editor.partner": "Partner",
  "addons.editor.partnerCommission": "Partner commission (%)",
  "addons.editor.cancel": "Cancel",
  "addons.editor.saving": "Saving...",
  "addons.editor.save": "Save",
  "addons.editor.newAddOn": "New add-on",
  "addons.editor.essentialsHint":
    "Fill in the essentials — everything else is optional and collapsed.",
  "addons.editor.essentials": "ESSENTIALS",
  "addons.editor.addPhoto": "Add photo",
  "addons.editor.photoHint":
    "Landscape photos work best. The cover photo is shown in the checkout list.",
  "addons.editor.howIsItPriced": "How is it priced?",
  "addons.editor.pricePerBooking": "Price per booking ({currency}) *",
  "addons.editor.pricePerGuest": "Price per guest ({currency}) *",
  "addons.editor.pricePerNight": "Price per night ({currency}) *",
  "addons.editor.pricePerGuestNight": "Price per guest per night ({currency}) *",
  "addons.editor.priceExample": "Example: 2 guests, 3 nights → {total} total",
  "addons.editor.moreOptions": "More options",
  "addons.editor.guestPreview": "GUEST PREVIEW",
  "addons.editor.previewCheckoutList": "Checkout list",
  "addons.editor.previewDetailView": "Detail view",
  "addons.editor.untitledAddOn": "Untitled add-on",
  "addons.editor.previewListHint":
    "How the add-on shows in the list of extras on your booking page. It is the same card guests see.",
  "addons.editor.previewDetailHint":
    "What guests see when they open the add-on, at phone size. It changes as you type. Fields you leave empty are not shown to guests.",
  "addons.preview.title": "Guest preview · {name}",
  "addons.preview.subtitle": "What guests see when they open this add-on on your booking page.",
  "addons.preview.inert": "Buttons in the preview don’t do anything.",
  "addons.preview.close": "Close guest preview",
  "addons.preview.done": "Done",
};
