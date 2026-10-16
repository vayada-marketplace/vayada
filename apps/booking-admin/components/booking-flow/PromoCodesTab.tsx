"use client";
import { useTranslation } from "@/lib/i18n";

import { useCallback, useMemo, useState, type FormEvent } from "react";
import {
  AdjustmentsHorizontalIcon,
  ChevronDownIcon,
  MagnifyingGlassIcon,
  PencilSquareIcon,
  PlusIcon,
  TicketIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { Input } from "@/components/ui";
import { PageHeader } from "@/components/layout/PageLayout";
import type { BookingPromoCode } from "@/services/api/bookingPromoCodesClient";
import { EditorModal } from "./EditorModal";

export interface PromoRoomType {
  roomTypeId: string;
  name: string;
}

export interface PromoCodeFormValues {
  code: string;
  discountType: "percentage" | "fixed";
  discountValue: string;
  minBookingValue: string;
  applicableRoomIds: string[];
  validFrom: string;
  validUntil: string;
  stayDateFrom: string;
  stayDateUntil: string;
  maxUses: string;
  isActive: boolean;
}

interface PromoCodesTabProps {
  promoCodes: BookingPromoCode[];
  propertyCurrency: string;
  propertyTimeZone: string;
  roomTypes: PromoRoomType[];
  onCreatePromoCode: (values: PromoCodeFormValues) => Promise<void>;
  onUpdatePromoCode: (promoCodeId: string, values: PromoCodeFormValues) => Promise<void>;
  onDeletePromoCode: (promoCodeId: string) => Promise<void>;
  onTogglePromoCode: (promoCode: BookingPromoCode) => Promise<void>;
}

function emptyDraft(): PromoCodeFormValues {
  return {
    code: "",
    discountType: "percentage",
    discountValue: "",
    minBookingValue: "",
    applicableRoomIds: [],
    validFrom: "",
    validUntil: "",
    stayDateFrom: "",
    stayDateUntil: "",
    maxUses: "1",
    isActive: true,
  };
}

function toDraft(promo: BookingPromoCode): PromoCodeFormValues {
  return {
    code: promo.code,
    discountType: promo.discountType,
    discountValue: promo.discountValue,
    minBookingValue: promo.minBookingValue ?? "",
    applicableRoomIds: promo.applicableRoomIds ?? [],
    validFrom: promo.validFrom ?? "",
    validUntil: promo.validUntil ?? "",
    stayDateFrom: promo.stayDateFrom ?? "",
    stayDateUntil: promo.stayDateUntil ?? "",
    maxUses: String(promo.maxUses),
    isActive: promo.isActive,
  };
}

type PromoStatus = "Active" | "Inactive" | "Expired" | "Exhausted";

/** The field a validation error belongs to; it gets a red border next to the error message. */
type PromoField =
  | "code"
  | "discountValue"
  | "minBookingValue"
  | "maxUses"
  | "validUntil"
  | "stayDateUntil";

function promoStatus(promo: BookingPromoCode, propertyTimeZone: string): PromoStatus {
  if (!promo.isActive) return "Inactive";
  const today = isoDateInTimeZone(propertyTimeZone);
  if (promo.validUntil && promo.validUntil < today) return "Expired";
  if (promo.currentUses >= promo.maxUses) return "Exhausted";
  if (promo.validFrom && promo.validFrom > today) return "Inactive";
  return "Active";
}

function isoDateInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: "year" | "month" | "day") =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function statusClasses(status: PromoStatus): string {
  if (status === "Active") return "bg-emerald-50 text-emerald-700";
  if (status === "Expired") return "bg-red-50 text-red-700";
  if (status === "Exhausted") return "bg-orange-50 text-orange-700";
  return "bg-gray-100 text-gray-600";
}

export default function PromoCodesTab({
  promoCodes,
  propertyCurrency,
  propertyTimeZone,
  roomTypes,
  onCreatePromoCode,
  onUpdatePromoCode,
  onDeletePromoCode,
  onTogglePromoCode,
}: PromoCodesTabProps) {
  const { t, locale } = useTranslation();
  function dateLabel(value: string | null): string {
    if (!value) return t("admin.noLimit");
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
      new Date(`${value}T12:00:00`),
    );
  }

  function rangeLabel(from: string | null, until: string | null): string {
    if (!from && !until) return t("admin.noLimit");
    if (from && until) return `${dateLabel(from)} – ${dateLabel(until)}`;
    return from
      ? t("admin.fromDate", { date: dateLabel(from) })
      : t("admin.untilDate", { date: dateLabel(until) });
  }

  function validityLabel(from: string | null, until: string | null): string {
    if (!from && !until) return t("admin.noExpiry");
    if (!until) return t("admin.dateNoExpiry", { date: dateLabel(from) });
    return rangeLabel(from, until);
  }

  function stayDatesLabel(from: string | null, until: string | null): string {
    return !from && !until ? t("admin.anyDates") : rangeLabel(from, until);
  }

  function moneyLabel(value: string, currency: string): string {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(Number(value));
  }

  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<PromoCodeFormValues>(emptyDraft);
  const [editingPromo, setEditingPromo] = useState<BookingPromoCode | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [savingPromo, setSavingPromo] = useState(false);
  const [busyPromoId, setBusyPromoId] = useState<string | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<PromoField | null>(null);

  const filteredPromoCodes = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return promoCodes;
    return promoCodes.filter((promo) =>
      [promo.code, t(`promos.status.${promoStatus(promo, propertyTimeZone)}`)].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
  }, [promoCodes, propertyTimeZone, search, t]);

  const openEditor = (promo: BookingPromoCode | null) => {
    setEditingPromo(promo);
    setDraft(promo ? toDraft(promo) : emptyDraft());
    setPromoError(null);
    setErrorField(null);
    setIsEditorOpen(true);
  };

  const closeEditor = useCallback(() => {
    if (savingPromo) return;
    setIsEditorOpen(false);
    setEditingPromo(null);
    setPromoError(null);
    setErrorField(null);
  }, [savingPromo]);

  const invalidClass = (field: PromoField) =>
    errorField === field ? "!border-red-400 focus:!ring-red-500" : "";

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = draft.code.trim().toUpperCase();
    const discountValue = Number(draft.discountValue);
    const minBookingValue = draft.minBookingValue.trim();
    const maxUses = Number(draft.maxUses);

    const invalid = (field: PromoField, message: string) => {
      setPromoError(message);
      setErrorField(field);
    };
    if (!/^[A-Z0-9_-]{2,40}$/.test(code)) {
      invalid("code", t("admin.use240LettersNumbersHyphensOrUnderscoresForThe"));
      return;
    }
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      invalid("discountValue", t("admin.discountValueMustBeGreaterThanZero"));
      return;
    }
    if (draft.discountType === "percentage" && discountValue > 100) {
      invalid("discountValue", t("admin.percentageDiscountsCannotExceed100"));
      return;
    }
    if (
      minBookingValue &&
      (!Number.isFinite(Number(minBookingValue)) || Number(minBookingValue) <= 0)
    ) {
      invalid("minBookingValue", t("admin.minimumBookingValueMustBeGreaterThanZero"));
      return;
    }
    if (!Number.isInteger(maxUses) || maxUses <= 0) {
      invalid("maxUses", t("admin.usageLimitMustBeAWholeNumberGreaterThanZero"));
      return;
    }
    if (draft.validFrom && draft.validUntil && draft.validUntil < draft.validFrom) {
      invalid("validUntil", t("admin.validUntilMustBeOnOrAfterValidFrom"));
      return;
    }
    if (draft.stayDateFrom && draft.stayDateUntil && draft.stayDateUntil < draft.stayDateFrom) {
      invalid("stayDateUntil", t("admin.stayUntilMustBeOnOrAfterStayFrom"));
      return;
    }

    const normalized = {
      ...draft,
      code,
      discountValue: discountValue.toFixed(2),
      minBookingValue: minBookingValue ? Number(minBookingValue).toFixed(2) : "",
      maxUses: String(maxUses),
    };
    setSavingPromo(true);
    setPromoError(null);
    setErrorField(null);
    try {
      if (editingPromo) await onUpdatePromoCode(editingPromo.promoCodeId, normalized);
      else await onCreatePromoCode(normalized);
      setIsEditorOpen(false);
      setEditingPromo(null);
    } catch {
      setPromoError(t("admin.failedToSavePromoCode"));
    } finally {
      setSavingPromo(false);
    }
  };

  const handleDelete = async (promo: BookingPromoCode) => {
    if (!window.confirm(t("admin.deleteName", { name: promo.code }))) return;
    setBusyPromoId(promo.promoCodeId);
    setPromoError(null);
    try {
      await onDeletePromoCode(promo.promoCodeId);
    } catch {
      setPromoError(t("admin.failedToDeletePromoCode"));
    } finally {
      setBusyPromoId(null);
    }
  };

  const roomNames = (roomIds: string[] | null) => {
    if (!roomIds?.length) return t("admin.allRooms");
    const names = roomIds.map(
      (roomId) =>
        roomTypes.find((room) => room.roomTypeId === roomId)?.name ?? t("admin.unknownRoom"),
    );
    return names.length > 2
      ? `${names.slice(0, 2).join(", ")} +${names.length - 2}`
      : names.join(", ");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("bookingFlow.tabs.promos")}
        subtitle={t("admin.targetedDiscountsGuestsUnlockByEnteringACodeAtCheckout")}
        actions={
          <button
            type="button"
            onClick={() => openEditor(null)}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700"
          >
            <PlusIcon className="h-4 w-4" />
            {t("admin.newPromoCode")}
          </button>
        }
      />

      {promoError && !isEditorOpen && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {promoError}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-200 p-4">
          <label className="relative block max-w-sm">
            <span className="sr-only">{t("admin.searchPromoCodes")}</span>
            <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-2.5 h-5 w-5 text-gray-400" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("admin.searchCodes")}
              className="h-10 w-full rounded-lg border border-gray-300 pl-10 pr-3 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
            />
          </label>
        </div>

        {promoCodes.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gray-100">
              <TicketIcon className="h-6 w-6 text-gray-500" />
            </span>
            <h2 className="mt-4 text-sm font-semibold text-gray-900">
              {t("bookingFlow.promoCodes.noPromoCodes")}
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              {t("admin.createYourFirstCodeToRewardGuests")}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1050px] text-left">
              <thead className="bg-gray-50 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="px-5 py-3">{t("affiliates.allAffiliates.code")}</th>
                  <th className="px-4 py-3">{t("admin.discount")}</th>
                  <th className="px-4 py-3">{t("admin.validity")}</th>
                  <th className="px-4 py-3">{t("admin.stayDates")}</th>
                  <th className="px-4 py-3">{t("admin.rooms")}</th>
                  <th className="px-4 py-3">{t("admin.usage")}</th>
                  <th className="px-5 py-3 text-right">{t("manageHotels.table.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 text-sm">
                {filteredPromoCodes.map((promo) => {
                  const status = promoStatus(promo, propertyTimeZone);
                  const usage = Math.min(100, (promo.currentUses / promo.maxUses) * 100);
                  return (
                    <tr key={promo.promoCodeId} className="hover:bg-gray-50/70">
                      <td className="px-5 py-4">
                        <div className="font-mono font-semibold text-gray-950">{promo.code}</div>
                        <span
                          className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${statusClasses(status)}`}
                        >
                          {t(`promos.status.${status}`)}
                        </span>
                      </td>
                      <td className="px-4 py-4 font-medium text-gray-900">
                        {promo.discountType === "percentage"
                          ? `${Number(promo.discountValue)}%`
                          : t("admin.amountOff", {
                              amount: moneyLabel(promo.discountValue, propertyCurrency),
                            })}
                      </td>
                      <td className="px-4 py-4 text-gray-600">
                        {validityLabel(promo.validFrom, promo.validUntil)}
                        {promo.minBookingValue && (
                          <div className="mt-1 text-xs font-normal text-gray-500">
                            {t("admin.min")}
                            {moneyLabel(promo.minBookingValue, propertyCurrency)}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-4 text-gray-600">
                        {stayDatesLabel(promo.stayDateFrom, promo.stayDateUntil)}
                      </td>
                      <td
                        className="max-w-[180px] truncate px-4 py-4 text-gray-600"
                        title={roomNames(promo.applicableRoomIds)}
                      >
                        {roomNames(promo.applicableRoomIds)}
                      </td>
                      <td className="px-4 py-4">
                        <div className="text-xs text-gray-600">
                          {promo.currentUses}/{promo.maxUses} {t("admin.used")}
                        </div>
                        <div className="mt-2 h-1.5 w-24 overflow-hidden rounded-full bg-gray-100">
                          <div
                            className="h-full rounded-full bg-primary-600"
                            style={{ width: `${usage}%` }}
                          />
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={promo.isActive}
                            aria-label={`${promo.isActive ? t("featureHub.copy.deactivate") : t("admin.activate")} ${promo.code}`}
                            disabled={busyPromoId === promo.promoCodeId}
                            onClick={async () => {
                              setBusyPromoId(promo.promoCodeId);
                              try {
                                await onTogglePromoCode(promo);
                              } catch {
                                setPromoError(t("admin.failedToUpdatePromoCode"));
                              } finally {
                                setBusyPromoId(null);
                              }
                            }}
                            className={`relative order-3 ml-2 h-5 w-9 rounded-full transition-colors disabled:opacity-50 ${promo.isActive ? "bg-primary-600" : "bg-gray-300"}`}
                          >
                            <span
                              className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${promo.isActive ? "translate-x-4" : "translate-x-0"}`}
                            />
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditor(promo)}
                            aria-label={t("admin.editName", { name: promo.code })}
                            className="order-1 rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                          >
                            <PencilSquareIcon className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDelete(promo)}
                            disabled={busyPromoId === promo.promoCodeId}
                            aria-label={t("admin.deleteName2", { name: promo.code })}
                            className="order-2 rounded-md p-2 text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                          >
                            <TrashIcon className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filteredPromoCodes.length === 0 && (
              <p className="px-6 py-12 text-center text-sm text-gray-500">
                {t("admin.noPromoCodesMatchYourSearch")}
              </p>
            )}
          </div>
        )}
      </div>

      {isEditorOpen && (
        <EditorModal
          idPrefix="promo-editor"
          title={editingPromo ? t("admin.editPromoCode") : t("admin.createPromoCode")}
          description={t("admin.guestsEnterThisCodeInTheBookingEngineDiscountsUse2", {
            currency: propertyCurrency,
          })}
          icon={TicketIcon}
          initialFocusId="promo-code"
          busy={savingPromo}
          error={promoError}
          active={draft.isActive}
          activeDescription={t("admin.turnOffToPauseTheCodeWithoutDeletingIt")}
          onActiveChange={() =>
            setDraft((current) => ({ ...current, isActive: !current.isActive }))
          }
          closeLabel={t("admin.closePromoCodeEditor")}
          submitLabel={
            savingPromo
              ? t("addons.editor.saving")
              : editingPromo
                ? t("admin.saveChanges")
                : t("admin.createPromoCode")
          }
          onClose={closeEditor}
          onSubmit={handleSubmit}
        >
          {/* Both cards share the grid rows (subgrid), so fields line up row by row. */}
          <div className="grid gap-5 md:grid-cols-2">
            <section aria-labelledby="promo-details-heading" className={sectionClass}>
              <SectionHeading id="promo-details-heading" icon={TicketIcon}>
                {t("admin.promoDetails")}
              </SectionHeading>
              <Field
                id="promo-code"
                label={t("affiliates.allAffiliates.code")}
                helper={t("promos.codeHint")}
              >
                <Input
                  id="promo-code"
                  aria-describedby="promo-code-helper"
                  aria-invalid={errorField === "code" || undefined}
                  autoComplete="off"
                  required
                  maxLength={40}
                  value={draft.code}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      code: event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""),
                    }))
                  }
                  placeholder={t("admin.eGSUMMER20")}
                  className={`${inputClass} ${invalidClass("code")}`}
                />
              </Field>

              <fieldset className="min-w-0">
                <legend className="text-sm font-medium text-gray-800">
                  {t("admin.discountType")}
                </legend>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  {(["percentage", "fixed"] as const).map((type) => (
                    <label
                      key={type}
                      className={`flex h-11 cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 transition-colors focus-within:outline-none focus-within:ring-2 focus-within:ring-primary-500 focus-within:ring-offset-2 ${draft.discountType === type ? "border-primary-600 bg-primary-50/60 ring-1 ring-inset ring-primary-600" : "border-gray-200 hover:border-gray-300"}`}
                    >
                      <input
                        className="sr-only"
                        type="radio"
                        name="discountType"
                        value={type}
                        aria-describedby="promo-discount-type-helper"
                        checked={draft.discountType === type}
                        onChange={() => setDraft((current) => ({ ...current, discountType: type }))}
                      />
                      <span className="truncate text-sm font-medium text-gray-900">
                        {type === "fixed" ? t("admin.fixedAmount") : t("admin.percentage")}
                      </span>
                      <span className="shrink-0 text-[13px] text-gray-600">
                        {type === "fixed" ? propertyCurrency : "%"}
                      </span>
                    </label>
                  ))}
                </div>
                <p id="promo-discount-type-helper" className="mt-2 text-xs text-gray-600">
                  {t("admin.chooseHowTheDiscountIsCalculated")}
                </p>
              </fieldset>

              <Field
                id="promo-discount-value"
                label={t("admin.discountValue")}
                helper={
                  draft.discountType === "fixed"
                    ? t("admin.usesYourPropertyCurrencyCurrency", { currency: propertyCurrency })
                    : t("admin.percentageRange")
                }
              >
                <div className="relative">
                  <Input
                    id="promo-discount-value"
                    aria-describedby="promo-discount-value-helper"
                    aria-invalid={errorField === "discountValue" || undefined}
                    required
                    type="number"
                    min="0.01"
                    max={draft.discountType === "percentage" ? "100" : undefined}
                    step="0.01"
                    value={draft.discountValue}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, discountValue: event.target.value }))
                    }
                    className={`${inputClass} pr-14 ${invalidClass("discountValue")}`}
                  />
                  <span className="pointer-events-none absolute right-3 top-3 text-sm text-gray-600">
                    {draft.discountType === "percentage" ? "%" : propertyCurrency}
                  </span>
                </div>
              </Field>

              <DateRangeFields
                id="promo-valid"
                legend={t("admin.validity")}
                helper={t("promos.validityHint")}
                fromLabel={t("admin.validFrom")}
                untilLabel={t("admin.validUntil")}
                from={draft.validFrom}
                until={draft.validUntil}
                untilInvalid={errorField === "validUntil"}
                onFrom={(value) => setDraft((current) => ({ ...current, validFrom: value }))}
                onUntil={(value) => setDraft((current) => ({ ...current, validUntil: value }))}
              />
            </section>

            <section aria-labelledby="promo-rules-heading" className={sectionClass}>
              <SectionHeading id="promo-rules-heading" icon={AdjustmentsHorizontalIcon}>
                {t("admin.rulesRestrictions")}
              </SectionHeading>
              <Field
                id="promo-min-booking-value"
                label={t("admin.minimumBookingValue")}
                helper={t("promos.minimumHint")}
              >
                <div className="relative">
                  <Input
                    id="promo-min-booking-value"
                    aria-describedby="promo-min-booking-value-helper"
                    aria-invalid={errorField === "minBookingValue" || undefined}
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={draft.minBookingValue}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, minBookingValue: event.target.value }))
                    }
                    placeholder={t("admin.eG500")}
                    className={`${inputClass} pr-14 ${invalidClass("minBookingValue")}`}
                  />
                  <span className="pointer-events-none absolute right-3 top-3 text-sm text-gray-600">
                    {propertyCurrency}
                  </span>
                </div>
              </Field>

              <Field id="promo-max-uses" label={t("admin.maxUses")} helper={t("promos.usageHint")}>
                <Input
                  id="promo-max-uses"
                  aria-describedby="promo-max-uses-helper"
                  aria-invalid={errorField === "maxUses" || undefined}
                  required
                  type="number"
                  min="1"
                  step="1"
                  value={draft.maxUses}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, maxUses: event.target.value }))
                  }
                  className={`${inputClass} ${invalidClass("maxUses")}`}
                />
              </Field>

              <div className="min-w-0">
                <p id="promo-rooms-label" className="text-sm font-medium text-gray-800">
                  {t("admin.applicableRooms")}
                </p>
                <details className="group mt-2 rounded-lg border border-gray-300 bg-white">
                  <summary
                    aria-labelledby="promo-rooms-label promo-rooms-value"
                    aria-describedby="promo-rooms-helper"
                    className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
                  >
                    <span id="promo-rooms-value">
                      {draft.applicableRoomIds.length === 0
                        ? t("admin.allRooms")
                        : t("admin.selectedRoomsCount", { count: draft.applicableRoomIds.length })}
                    </span>
                    <ChevronDownIcon className="h-4 w-4 shrink-0 text-gray-500 transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="max-h-40 space-y-1 overflow-y-auto border-t border-gray-200 p-2">
                    {roomTypes.length === 0 ? (
                      <p className="px-2 py-1 text-xs text-gray-500">
                        {t("admin.noRoomTypesAvailable")}
                      </p>
                    ) : (
                      roomTypes.map((room) => (
                        <label
                          key={room.roomTypeId}
                          className="flex items-center gap-2 rounded px-2 py-2 text-sm text-gray-700 hover:bg-gray-50"
                        >
                          <input
                            type="checkbox"
                            checked={draft.applicableRoomIds.includes(room.roomTypeId)}
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                applicableRoomIds: event.target.checked
                                  ? [...current.applicableRoomIds, room.roomTypeId]
                                  : current.applicableRoomIds.filter(
                                      (id) => id !== room.roomTypeId,
                                    ),
                              }))
                            }
                            className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                          />
                          {room.name}
                        </label>
                      ))
                    )}
                  </div>
                </details>
                <p id="promo-rooms-helper" className="mt-2 text-xs text-gray-600">
                  {t("admin.leaveAsAllRoomsToApplyToAnyBookingOr")}
                </p>
              </div>

              <DateRangeFields
                id="promo-stay"
                legend={t("promos.stayDates")}
                helper={t("promos.stayDatesHint")}
                fromLabel={t("admin.staysFrom")}
                untilLabel={t("admin.staysUntil")}
                from={draft.stayDateFrom}
                until={draft.stayDateUntil}
                untilInvalid={errorField === "stayDateUntil"}
                onFrom={(value) => setDraft((current) => ({ ...current, stayDateFrom: value }))}
                onUntil={(value) => setDraft((current) => ({ ...current, stayDateUntil: value }))}
              />
            </section>
          </div>
        </EditorModal>
      )}
    </div>
  );
}

const inputClass = "h-11 !text-sm placeholder:text-gray-500";
// Header + four field rows; on md+ both cards take the same rows of the parent grid.
const sectionClass =
  "grid min-w-0 gap-5 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5 md:row-span-5 md:grid-rows-subgrid";

function SectionHeading({
  id,
  icon: Icon,
  children,
}: {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-gray-100 pb-4">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-50 text-primary-700">
        <Icon className="h-4 w-4" />
      </span>
      <h3 id={id} className="text-sm font-semibold text-gray-950">
        {children}
      </h3>
    </div>
  );
}

/** Label, then the control, then help text, so controls in a row line up across both cards. */
function Field({
  id,
  label,
  helper,
  children,
}: {
  id: string;
  label: string;
  helper: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-medium text-gray-800">
        {label}
      </label>
      <div className="mt-2">{children}</div>
      <p id={`${id}-helper`} className="mt-2 text-xs text-gray-600">
        {helper}
      </p>
    </div>
  );
}

function DateRangeFields({
  id,
  legend,
  helper,
  fromLabel,
  untilLabel,
  from,
  until,
  untilInvalid,
  onFrom,
  onUntil,
}: {
  id: string;
  legend: string;
  helper: string;
  fromLabel: string;
  untilLabel: string;
  from: string;
  until: string;
  untilInvalid: boolean;
  onFrom: (value: string) => void;
  onUntil: (value: string) => void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="text-sm font-medium text-gray-800">{legend}</legend>
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-from`} className="text-xs font-medium text-gray-600">
            {fromLabel}
          </label>
          <Input
            id={`${id}-from`}
            aria-describedby={`${id}-helper`}
            type="date"
            value={from}
            onChange={(event) => onFrom(event.target.value)}
            className={`${inputClass} mt-1`}
          />
        </div>
        <div>
          <label htmlFor={`${id}-until`} className="text-xs font-medium text-gray-600">
            {untilLabel}
          </label>
          <Input
            id={`${id}-until`}
            aria-describedby={`${id}-helper`}
            aria-invalid={untilInvalid || undefined}
            type="date"
            value={until}
            onChange={(event) => onUntil(event.target.value)}
            className={`${inputClass} mt-1 ${untilInvalid ? "!border-red-400 focus:!ring-red-500" : ""}`}
          />
        </div>
      </div>
      <p id={`${id}-helper`} className="mt-2 text-xs text-gray-600">
        {helper}
      </p>
    </fieldset>
  );
}
