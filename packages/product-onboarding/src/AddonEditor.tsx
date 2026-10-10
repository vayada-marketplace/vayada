"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

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
  leadTime: string;
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
    leadTime: "",
    maxQuantity: "1",
    perPerson: false,
    perNight: false,
    photos: [],
    ownershipKind: "property",
    partnerCommissionRate: "",
  };
}
// [label, description, perPerson, perNight, price label, preview unit]
const models = [
  [
    "addons.editor.flatFee",
    "addons.editor.fixedPricePerBooking",
    false,
    false,
    "addons.editor.pricePerBooking",
    "addons.editor.unitPerBooking",
  ],
  [
    "addons.editor.perPerson",
    "addons.editor.baseNumberOfGuests",
    true,
    false,
    "addons.editor.pricePerGuest",
    "addons.editor.unitPerGuest",
  ],
  [
    "addons.editor.perNight",
    "addons.editor.baseNumberOfNights",
    false,
    true,
    "addons.editor.pricePerNight",
    "addons.editor.unitPerNight",
  ],
  [
    "addons.editor.perPersonNight",
    "addons.editor.baseGuestsNights",
    true,
    true,
    "addons.editor.pricePerGuestNight",
    "addons.editor.unitPerGuestNight",
  ],
] as const;
const categories = ["dining", "transport", "wellness", "experience", "other"] as const;
// Fields under "More options"; opened when they hold values or have errors.
const optionalFields = [
  "maxQuantity",
  "duration",
  "leadTime",
  "location",
  "maxGuests",
  "partnerCommissionRate",
] as const;
const inputClass =
  "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500";

function formatPrice(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export function AddonEditor({
  translate,
  initialValues,
  currency,
  editing,
  onSave,
  onCancel,
}: {
  translate?: (key: string, params?: Record<string, string | number>) => string;
  initialValues: AddonEditorValues;
  currency: string;
  editing: boolean;
  onSave: (values: AddonEditorValues) => Promise<void> | void;
  onCancel: () => void;
}) {
  const t =
    translate ??
    ((key: string, params?: Record<string, string | number>) => {
      let message = AddonEditorMessages[key as keyof typeof AddonEditorMessages];
      for (const [name, value] of Object.entries(params ?? {}))
        message = message.split(`{${name}}`).join(String(value));
      return message;
    });
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [moreOpen, setMoreOpen] = useState(
    initialValues.ownershipKind === "partner" ||
      ["duration", "leadTime", "location", "maxGuests"].some(
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
  const cover = values.photos.find((photo) => photo.isCover) ?? values.photos[0];
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
        <div className="grid min-h-0 overflow-y-auto md:grid-cols-[minmax(0,1fr)_20rem]">
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
                {categories.map((category) => (
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
                  {field(
                    "leadTime",
                    t("addons.editor.leadTime"),
                    "text",
                    t("addons.editor.eG24hBefore"),
                  )}
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
            <h3 className="text-xs font-semibold tracking-widest text-gray-500">
              {t("addons.editor.checkoutPreview")}
            </h3>
            <div
              aria-hidden="true"
              className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm"
            >
              {cover ? (
                <img src={cover.imageUrl} alt="" className="h-36 w-full object-cover" />
              ) : (
                <div className="flex h-36 items-center justify-center bg-primary-50 text-sm text-gray-500">
                  {t("addons.editor.noPhotoYet")}
                </div>
              )}
              <div className="space-y-2 p-4">
                <p className="font-semibold text-gray-900">
                  {values.name.trim() || t("addons.editor.untitledAddOn")}
                </p>
                <p className="line-clamp-3 text-sm text-gray-600">
                  {values.description.trim() || t("addons.editor.previewDescription")}
                </p>
                <div className="flex items-end justify-between gap-2 pt-1">
                  <div>
                    <p className="font-semibold text-gray-900">{formatPrice(price, currency)}</p>
                    <p className="text-xs text-gray-500">{t(model[5])}</p>
                  </div>
                  <span className="rounded-lg bg-primary-600 px-3 py-1.5 text-sm font-medium text-white">
                    {t("addons.editor.add")}
                  </span>
                </div>
              </div>
            </div>
            <p className="mt-3 text-xs text-gray-500">{t("addons.editor.previewHint")}</p>
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
  "addons.editor.add": "Add",
  "addons.editor.addPhotos": "Add photos",
  "addons.editor.duration": "Duration",
  "addons.editor.eG2Hours": "e.g., 2 hours",
  "addons.editor.location": "Location",
  "addons.editor.eGHotelLobby": "e.g., Hotel lobby",
  "addons.editor.maxGuests": "Max guests",
  "addons.editor.eG6": "e.g., 6",
  "addons.editor.leadTime": "Lead time",
  "addons.editor.eG24hBefore": "e.g., 24h before",
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
  "addons.editor.checkoutPreview": "CHECKOUT PREVIEW",
  "addons.editor.noPhotoYet": "No photo yet",
  "addons.editor.untitledAddOn": "Untitled add-on",
  "addons.editor.previewDescription": "Add a description so guests know what they get.",
  "addons.editor.unitPerBooking": "per booking",
  "addons.editor.unitPerGuest": "per guest",
  "addons.editor.unitPerNight": "per night",
  "addons.editor.unitPerGuestNight": "per guest per night",
  "addons.editor.previewHint": "A preview of how this add-on appears in the booking flow.",
};
