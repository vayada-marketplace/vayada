"use client";
import { useTranslation } from "@/lib/i18n";

import { useState, type DragEvent } from "react";
import {
  AddonEditor,
  emptyAddonValues,
  type AddonEditorValues,
} from "@vayada/product-onboarding/AddonEditor";
import Link from "next/link";
import {
  DocumentDuplicateIcon,
  MagnifyingGlassIcon,
  PencilIcon,
  PhotoIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { ToggleSwitch } from "@/components/ui";
import type { AddonItem, AddonSettings } from "@/services/settings";
import { cn, formatCurrency } from "@/lib/utils";

// The redesign's filter chips; "other" appears only when an add-on uses it.
const FILTER_CATEGORIES = ["dining", "transport", "wellness", "experience"];

const PRICING_MODEL_LABELS: Record<string, string> = {
  "false:false": "addons.editor.flatFee",
  "true:false": "addons.editor.perPerson",
  "false:true": "addons.editor.perNight",
  "true:true": "addons.editor.perPersonNight",
};

export type AddonItemFormValues = AddonEditorValues;

function AddonsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  );
}

function toDraft(addon: AddonItem, currency: string): AddonItemFormValues {
  return {
    ...emptyAddonValues(currency),
    ...addon,
    currency,
    price: addon.price.toFixed(2),
    category: addon.category as AddonEditorValues["category"],
    duration: addon.duration ?? "",
    location: addon.location ?? "",
    maxGuests: addon.maxGuests ?? "",
    leadTime: addon.leadTime ?? "",
    maxQuantity: String(addon.maxQuantity ?? 1),
    perPerson: addon.perPerson === true,
    perNight: addon.perNight === true,
    partnerCommissionRate: addon.partnerCommissionRate ?? "",
    photos:
      addon.photos ??
      (addon.image
        ? [
            {
              imageUrl: addon.image,
              mediaObjectId: addon.imageMediaObjectId ?? null,
              isCover: true,
            },
          ]
        : []),
  };
}

function orderAddons(addons: AddonItem[]): AddonItem[] {
  return addons
    .map((addon, index) => ({ addon, index }))
    .sort((left, right) => {
      const leftOrder = left.addon.sortOrder ?? left.index;
      const rightOrder = right.addon.sortOrder ?? right.index;
      return leftOrder - rightOrder || left.index - right.index;
    })
    .map(({ addon }) => addon);
}

interface AddonsTabProps {
  addons: AddonItem[];
  addonSettings: AddonSettings;
  propertyCurrency: string;
  propertyPlan: {
    plan: "commission" | "fixed";
    limits: { maxAddons: number };
  };
  handleToggleAddonSetting: (key: keyof AddonSettings) => void;
  onCreateAddon: (values: AddonItemFormValues, options?: { hidden?: boolean }) => Promise<void>;
  onUpdateAddon: (addonId: string, values: AddonItemFormValues) => Promise<void>;
  onDeleteAddon: (addonId: string) => Promise<void>;
  onReorderAddon: (sourceAddonId: string, targetAddonId: string) => Promise<void>;
  onToggleAddonLive: (addon: AddonItem) => Promise<void>;
}

export default function AddonsTab({
  addons,
  addonSettings,
  propertyCurrency,
  propertyPlan,
  handleToggleAddonSetting,
  onCreateAddon,
  onUpdateAddon,
  onDeleteAddon,
  onReorderAddon,
  onToggleAddonLive,
}: AddonsTabProps) {
  const { t, locale } = useTranslation();
  const [filterCategory, setFilterCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<AddonItemFormValues>(() => emptyAddonValues(propertyCurrency));
  const [editingAddon, setEditingAddon] = useState<AddonItem | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [savingItem, setSavingItem] = useState(false);
  const [busyAddonId, setBusyAddonId] = useState<string | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const [draggingAddonId, setDraggingAddonId] = useState<string | null>(null);
  const orderedAddons = orderAddons(addons);
  const categories = [
    ...FILTER_CATEGORIES,
    ...(addons.some((addon) => addon.category === "other") ? ["other"] : []),
  ];
  const query = search.trim().toLocaleLowerCase();
  const filteredAddons = orderedAddons.filter(
    (addon) =>
      (filterCategory === "all" || addon.category === filterCategory) &&
      (!query || `${addon.name} ${addon.description}`.toLocaleLowerCase().includes(query)),
  );
  const canReorder = filterCategory === "all" && !query && orderedAddons.length > 1;
  const liveCount = addons.filter((addon) => addon.live !== false).length;
  const maxAddons = propertyPlan.limits.maxAddons;
  const addonLimitReached = addons.length >= maxAddons;
  const addonLimitMessage =
    propertyPlan.plan === "commission"
      ? addons.length > maxAddons
        ? t("admin.youHaveMoreAddOnsThanYourPlanAllowsRemove")
        : t("admin.youVeReachedThe3AddOnLimitUpgradeTo")
      : t("admin.youVeReachedThe9AddOnLimitForThe");

  const openCreateEditor = () => {
    setEditingAddon(null);
    setDraft(emptyAddonValues(propertyCurrency));
    setItemError(null);
    setIsEditorOpen(true);
  };

  const openEditEditor = (addon: AddonItem) => {
    setEditingAddon(addon);
    setDraft(toDraft(addon, propertyCurrency));
    setItemError(null);
    setIsEditorOpen(true);
  };

  const closeEditor = () => {
    if (savingItem) return;
    setIsEditorOpen(false);
    setEditingAddon(null);
    setItemError(null);
  };

  const handleSave = async (values: AddonItemFormValues) => {
    setSavingItem(true);
    try {
      if (editingAddon) await onUpdateAddon(editingAddon.id, values);
      else await onCreateAddon(values);
      setIsEditorOpen(false);
      setEditingAddon(null);
    } finally {
      setSavingItem(false);
    }
  };

  const runRowAction = async (addon: AddonItem, action: () => Promise<void>) => {
    setBusyAddonId(addon.id);
    setItemError(null);
    try {
      await action();
    } finally {
      setBusyAddonId(null);
    }
  };

  const handleDelete = (addon: AddonItem) => {
    if (!window.confirm(t("admin.deleteName", { name: addon.name }))) return;
    void runRowAction(addon, () =>
      onDeleteAddon(addon.id).catch(() => setItemError(t("admin.failedToDeleteAddOn"))),
    );
  };

  // The copy starts hidden so guests never see it before the host edits it. Imported photos
  // without a media object can't be attached to a new add-on, so it keeps only uploaded ones.
  const handleDuplicate = (addon: AddonItem) => {
    const values = toDraft(addon, propertyCurrency);
    const photos = values.photos.filter((photo) => photo.mediaObjectId);
    const keepsCover = photos.some((photo) => photo.isCover);
    void runRowAction(addon, () =>
      onCreateAddon(
        {
          ...values,
          name: t("addons.list.copyName", { name: addon.name }),
          photos: photos.map((photo, index) => ({
            ...photo,
            isCover: keepsCover ? photo.isCover : index === 0,
          })),
        },
        { hidden: true },
      ).catch(() => undefined),
    );
  };

  const handleDragStart = (event: DragEvent<HTMLButtonElement>, addonId: string) => {
    if (!canReorder) {
      event.preventDefault();
      return;
    }

    setDraggingAddonId(addonId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", addonId);
  };

  const handleDragOver = (event: DragEvent<HTMLLIElement>, targetAddonId: string) => {
    const sourceAddonId = draggingAddonId || event.dataTransfer.getData("text/plain");
    if (!canReorder || !sourceAddonId || sourceAddonId === targetAddonId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const handleDrop = async (event: DragEvent<HTMLLIElement>, targetAddonId: string) => {
    event.preventDefault();
    const sourceAddonId = event.dataTransfer.getData("text/plain") || draggingAddonId;
    setDraggingAddonId(null);
    if (!canReorder || !sourceAddonId || sourceAddonId === targetAddonId) return;

    setItemError(null);
    try {
      await onReorderAddon(sourceAddonId, targetAddonId);
    } catch {
      setItemError(t("admin.failedToReorderAddOns"));
    }
  };

  const chipClass = (active: boolean) =>
    cn(
      "rounded-full border px-3.5 py-1.5 text-[13px] transition-colors",
      active
        ? "border-primary-500 bg-primary-50 text-primary-700"
        : "border-gray-200 bg-white text-gray-600 hover:border-gray-300",
    );
  const iconButtonClass =
    "rounded-lg border border-gray-200 bg-white p-2 text-gray-600 hover:bg-gray-50 hover:text-gray-900 disabled:opacity-50";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 md:text-2xl">
            {t("bookingFlow.tabs.addons")}
          </h1>
          <p className="mt-1 text-[13px] text-gray-500">
            {t(addons.length === 1 ? "addons.list.summaryOne" : "addons.list.summary", {
              count: addons.length,
              live: liveCount,
              currency: propertyCurrency,
            })}
          </p>
        </div>
        <button
          onClick={openCreateEditor}
          disabled={addonLimitReached}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-4 py-2 text-[13px] font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <PlusIcon className="h-4 w-4" />
          {t("addons.list.new")}
        </button>
      </div>

      {addonLimitReached && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          <p>
            {addonLimitMessage} ({addons.length}/{maxAddons} {t("admin.addOns")})
          </p>
          {propertyPlan.plan === "commission" && (
            <Link
              href="/settings/billing"
              className="mt-1 inline-block font-semibold underline underline-offset-2"
            >
              {t("admin.upgradeToOfferUpTo9AddOnsAndIncrease")}
            </Link>
          )}
        </div>
      )}

      {itemError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {itemError}
        </div>
      )}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <label className="relative block lg:w-80 lg:shrink-0">
          <span className="sr-only">{t("addons.list.search")}</span>
          <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("addons.list.search")}
            className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            aria-pressed={filterCategory === "all"}
            onClick={() => setFilterCategory("all")}
            className={chipClass(filterCategory === "all")}
          >
            {t("addons.list.all")}
          </button>
          {categories.map((category) => (
            <button
              key={category}
              type="button"
              aria-pressed={filterCategory === category}
              onClick={() => setFilterCategory(category)}
              className={chipClass(filterCategory === category)}
            >
              {t(`addons.category.${category}`)}
            </button>
          ))}
        </div>
      </div>

      {addons.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center">
          <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-gray-100">
            <AddonsIcon className="h-5 w-5 text-gray-400" />
          </div>
          <p className="text-[13px] font-medium text-gray-600">
            {t("bookingFlow.addons.noAddons")}
          </p>
          <p className="mt-0.5 text-[12px] text-gray-400">{t("bookingFlow.addons.noAddonsDesc")}</p>
        </div>
      ) : filteredAddons.length === 0 ? (
        <p className="rounded-2xl border border-gray-200 bg-white p-6 text-center text-[13px] text-gray-500">
          {t("addons.list.noMatches")}
        </p>
      ) : (
        <ul className="space-y-3">
          {filteredAddons.map((addon) => {
            const photoCount = addon.photos?.length ?? (addon.image ? 1 : 0);
            const live = addon.live !== false;
            return (
              <li
                key={addon.id}
                data-testid={`booking-addon-item-${addon.id}`}
                onDragOver={(event) => handleDragOver(event, addon.id)}
                onDrop={(event) => handleDrop(event, addon.id)}
                className={cn(
                  "flex flex-col gap-4 rounded-2xl border bg-white p-4 transition-colors sm:flex-row sm:items-start md:p-5",
                  draggingAddonId === addon.id ? "border-gray-400" : "border-gray-200",
                )}
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <button
                    type="button"
                    aria-label={t("admin.dragName", { name: addon.name })}
                    title={
                      canReorder
                        ? t("admin.dragToReorder")
                        : t("admin.reorderingIsAvailableInAllView")
                    }
                    draggable={canReorder}
                    disabled={!canReorder}
                    onDragStart={(event) => handleDragStart(event, addon.id)}
                    onDragEnd={() => setDraggingAddonId(null)}
                    className={cn(
                      "mt-6 shrink-0 rounded p-0.5 text-gray-300",
                      canReorder
                        ? "cursor-grab hover:text-gray-500 active:cursor-grabbing"
                        : "cursor-not-allowed opacity-50",
                    )}
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="9" cy="6" r="1.5" />
                      <circle cx="15" cy="6" r="1.5" />
                      <circle cx="9" cy="12" r="1.5" />
                      <circle cx="15" cy="12" r="1.5" />
                      <circle cx="9" cy="18" r="1.5" />
                      <circle cx="15" cy="18" r="1.5" />
                    </svg>
                  </button>

                  <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-center text-[12px] text-gray-600">
                    {photoCount > 0 ? (
                      t(photoCount === 1 ? "addons.list.onePhoto" : "addons.list.photos", {
                        count: photoCount,
                      })
                    ) : (
                      <PhotoIcon className="h-6 w-6 text-gray-500" aria-hidden="true" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p
                        data-testid="booking-addon-item-name"
                        className="text-[15px] font-semibold text-gray-900"
                      >
                        {addon.name}
                      </p>
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">
                        {t(`addons.category.${addon.category}`)}
                      </span>
                      {!live && (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500">
                          {t("addons.list.hidden")}
                        </span>
                      )}
                    </div>
                    {addon.description && (
                      <p className="mt-1 line-clamp-2 text-[13px] text-gray-600">
                        {addon.description}
                      </p>
                    )}
                    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-gray-500">
                      <li className="font-semibold text-gray-900">
                        {formatCurrency(addon.price, propertyCurrency, locale, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </li>
                      <li>
                        {t(
                          PRICING_MODEL_LABELS[
                            `${addon.perPerson === true}:${addon.perNight === true}`
                          ]!,
                        )}
                      </li>
                      {addon.maxQuantity != null && (
                        <li>{t("addons.list.maxPerBooking", { count: addon.maxQuantity })}</li>
                      )}
                      {addon.duration && <li>{addon.duration}</li>}
                      {addon.leadTime && <li>{addon.leadTime}</li>}
                      {addon.ownershipKind === "partner" && (
                        <li>
                          {t("admin.partnerRate", { rate: addon.partnerCommissionRate ?? "" })}
                        </li>
                      )}
                    </ul>
                  </div>
                </div>

                <div className="flex items-center gap-2 sm:shrink-0">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={live}
                    aria-label={t("addons.list.showOnBookingEngine", { name: addon.name })}
                    disabled={busyAddonId === addon.id}
                    onClick={() => void runRowAction(addon, () => onToggleAddonLive(addon))}
                    className={cn(
                      "relative mr-1 h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:opacity-60",
                      live ? "bg-primary-600" : "bg-gray-200",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
                        live && "translate-x-5",
                      )}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => openEditEditor(addon)}
                    aria-label={t("admin.editName", { name: addon.name })}
                    className={iconButtonClass}
                  >
                    <PencilIcon className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDuplicate(addon)}
                    disabled={addonLimitReached || busyAddonId === addon.id}
                    aria-label={t("addons.list.duplicate", { name: addon.name })}
                    className={iconButtonClass}
                  >
                    <DocumentDuplicateIcon className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(addon)}
                    disabled={busyAddonId === addon.id}
                    aria-label={t("admin.deleteName2", { name: addon.name })}
                    className={cn(iconButtonClass, "hover:bg-red-50 hover:text-red-600")}
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Display Settings */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-[14px] font-semibold text-gray-900">
          {t("bookingFlow.addons.displaySettings")}
        </h2>
        <p className="mb-4 mt-0.5 text-[12px] text-gray-500">
          {t("bookingFlow.addons.displaySettingsDesc")}
        </p>

        <div className="space-y-2">
          <ToggleSwitch
            size="sm"
            enabled={addonSettings.showAddonsStep}
            onChange={() => handleToggleAddonSetting("showAddonsStep")}
            label={t("bookingFlow.addons.showAddonsStep")}
            description={t("bookingFlow.addons.showAddonsStepDesc")}
          />
          <ToggleSwitch
            size="sm"
            enabled={addonSettings.groupAddonsByCategory}
            onChange={() => handleToggleAddonSetting("groupAddonsByCategory")}
            label={t("bookingFlow.addons.groupByCategory")}
            description={t("bookingFlow.addons.groupByCategoryDesc")}
          />
        </div>
      </div>

      {isEditorOpen && (
        <AddonEditor
          translate={t}
          initialValues={draft}
          currency={propertyCurrency}
          editing={Boolean(editingAddon)}
          onSave={handleSave}
          onCancel={closeEditor}
        />
      )}
    </div>
  );
}
