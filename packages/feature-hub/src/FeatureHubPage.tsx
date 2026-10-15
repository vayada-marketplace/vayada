"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  ArrowPathIcon,
  CheckCircleIcon,
  CheckIcon,
  InformationCircleIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";

import {
  activeNavModules,
  CORE_NAV_ITEMS,
  FEATURE_MODULE_NAV_INDEX,
  FEATURE_MODULES,
  isModuleNew,
} from "./registry";
import type { FeatureActivationClient, FeatureModule, FeatureProduct } from "./types";
import { useFeatureModuleActivations } from "./useFeatureModuleActivations";

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface FeatureHubPageProps {
  translate?: Translate;
  /**
   * Prefer a module-scoped or memoized client. The hook stores the latest value
   * in a ref so refresh callbacks stay stable across renders.
   */
  activationClient: FeatureActivationClient;
}

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const PREVIEW_PRODUCTS: FeatureProduct[] = ["pms", "booking_engine"];

/** One list of every module, whichever app shows it (VAY-2200). */
export function FeatureHubPage({ translate, activationClient }: FeatureHubPageProps) {
  // Module copy the host catalog lacks falls back to the English defaults, not to the raw key.
  const t = useMemo<Translate>(
    () =>
      translate
        ? (key, params) => {
            const text = translate(key, params);
            return text === key && key in featureHubMessages ? defaultTranslate(key, params) : text;
          }
        : defaultTranslate,
    [translate],
  );
  const [selectedModule, setSelectedModule] = useState<FeatureModule | null>(null);
  const [notice, setNotice] = useState("");
  const [updateError, setUpdateError] = useState("");
  const [savingModuleId, setSavingModuleId] = useState<string | null>(null);
  const {
    activeModuleIds,
    configuredModuleSet,
    supportedModuleIds,
    canManage,
    manageableModuleSet,
    loading,
    error,
    setModuleActive,
  } = useFeatureModuleActivations(activationClient);
  const canManageModule = (moduleId: string) =>
    manageableModuleSet ? manageableModuleSet.has(moduleId) : canManage;
  const now = useMemo(() => new Date(), []);

  // A store that could not be read leaves its modules out; unavailable modules always show.
  const { listed, switchable } = useMemo(() => {
    const supported = new Set(supportedModuleIds);
    return {
      listed: FEATURE_MODULES.filter((module) => module.unavailable || supported.has(module.id)),
      switchable: FEATURE_MODULES.filter(
        (module) => !module.unavailable && supported.has(module.id),
      ),
    };
  }, [supportedModuleIds]);
  const activeCount = switchable.filter((module) => activeModuleIds.includes(module.id)).length;
  const waitingForInventory = loading && switchable.length === 0;
  const inventoryFailed = Boolean(error) && switchable.length === 0;

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(""), 3800);
    return () => window.clearTimeout(id);
  }, [notice]);

  const toggleModule = async (module: FeatureModule, isActive: boolean) => {
    if (savingModuleId) return;
    setNotice("");
    setUpdateError("");
    setSavingModuleId(module.id);
    try {
      await setModuleActive(module.id, isActive);
      setNotice(
        t(isActive ? "featureHub.activated" : "featureHub.deactivated", {
          name: t(`featureHub.modules.${module.id}.name`),
        }),
      );
    } catch (error) {
      setUpdateError(
        t === defaultTranslate && error instanceof Error
          ? error.message
          : "featureHub.copy.couldNotUpdateModuleActivation",
      );
    } finally {
      setSavingModuleId(null);
    }
  };

  const switchProps = (module: FeatureModule) => ({
    isActive: configuredModuleSet.has(module.id),
    disabled: loading || !canManageModule(module.id) || savingModuleId !== null,
    saving: savingModuleId === module.id,
    onToggle: (isActive: boolean) => toggleModule(module, isActive),
  });

  return (
    <div className="min-h-full bg-gray-50 p-4 text-gray-950 md:p-6">
      <header className="flex flex-col gap-3 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-gray-900 md:text-2xl">
            {t("featureHub.copy.featureHub")}
          </h1>
          <p className="mt-1 max-w-2xl text-[13px] text-gray-500">
            {t("featureHub.copy.activatePropertyModulesAndKeepNavigationFocusedOnTheTools")}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {loading && (
            <span className="inline-flex h-7 items-center gap-1 rounded-full border border-gray-200 bg-white px-3 text-xs font-medium text-gray-500">
              <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
              {t("featureHub.copy.syncing")}
            </span>
          )}
          <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 text-xs font-medium text-gray-700">
            <CheckCircleIcon className="h-3.5 w-3.5 text-primary-600" />
            <span className="font-semibold text-primary-700">{activeCount}</span>
            <span>{t("featureHub.copy.ofTotalActive", { total: switchable.length })}</span>
          </span>
        </div>
      </header>

      {(error || (updateError && !selectedModule)) && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          {updateError ? t(updateError) || updateError : t("featureHub.copy.couldNotLoadModules")}
        </div>
      )}
      {notice && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm font-medium text-green-700">
          <CheckCircleIcon className="h-4 w-4 shrink-0" />
          {notice}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px] xl:grid-cols-[minmax(0,1fr)_300px]">
        <main className="min-w-0">
          {waitingForInventory ? (
            <div
              role="status"
              className="flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-5 py-12 text-sm text-gray-500"
            >
              <ArrowPathIcon className="h-4 w-4 animate-spin" />
              {t("featureHub.copy.loadingModules")}
            </div>
          ) : inventoryFailed ? null : (
            <div className="grid gap-4 md:grid-cols-2">
              {listed.map((module) =>
                module.unavailable ? (
                  <UnavailableCard key={module.id} t={t} module={module} />
                ) : (
                  <ModuleCard
                    key={module.id}
                    t={t}
                    module={module}
                    isNew={isModuleNew(module, now)}
                    onOpen={() => setSelectedModule(module)}
                    {...switchProps(module)}
                  />
                ),
              )}
            </div>
          )}
          <p className="mt-4 text-[13px] leading-5 text-gray-500">
            {t("featureHub.copy.disabledModulesStayHidden")}
          </p>
        </main>

        {!waitingForInventory && !inventoryFailed && (
          <aside className="lg:sticky lg:top-4 lg:self-start">
            <NavigationPreview t={t} activeModuleIds={activeModuleIds} />
          </aside>
        )}
      </div>

      {selectedModule && (
        <DetailModal
          t={t}
          module={selectedModule}
          isNew={isModuleNew(selectedModule, now)}
          error={updateError ? t(updateError) || updateError : ""}
          onClose={() => setSelectedModule(null)}
          {...switchProps(selectedModule)}
        />
      )}
    </div>
  );
}

type SwitchProps = {
  isActive: boolean;
  disabled: boolean;
  saving: boolean;
  onToggle: (isActive: boolean) => void;
};

function ModuleCard({
  t,
  module,
  isNew,
  onOpen,
  isActive,
  disabled,
  saving,
  onToggle,
}: SwitchProps & { t: Translate; module: FeatureModule; isNew: boolean; onOpen: () => void }) {
  const name = t(`featureHub.modules.${module.id}.name`);
  return (
    // The name is the keyboard way in; the rest of the card is a larger pointer target.
    <article
      onClick={onOpen}
      className={cx(
        "flex cursor-pointer items-start gap-3.5 rounded-xl border p-5 transition-colors",
        isActive
          ? "border-primary-200 bg-primary-50/50"
          : "border-gray-200 bg-white hover:border-gray-300",
      )}
    >
      <ModuleIcon module={module} active={isActive} />
      <div className="min-w-0 flex-1">
        <div className="flex min-h-6 flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-semibold text-gray-900">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpen();
              }}
              className="rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            >
              {name}
            </button>
          </h2>
          {isNew && <NewBadge t={t} />}
        </div>
        <p className="mt-1 text-[13px] leading-5 text-gray-500">
          {t(`featureHub.modules.${module.id}.description`)}
        </p>
        <CategoryTag t={t} module={module} className="mt-2.5" />
      </div>
      <span onClick={(event: MouseEvent) => event.stopPropagation()}>
        <ToggleSwitch
          checked={isActive}
          disabled={disabled || saving}
          ariaLabel={t("admin.actionName", {
            action: isActive ? t("featureHub.copy.deactivate") : t("admin.activate"),
            name,
          })}
          onChange={onToggle}
        />
      </span>
    </article>
  );
}

function UnavailableCard({ t, module }: { t: Translate; module: FeatureModule }) {
  return (
    <article className="flex items-start gap-3.5 rounded-xl border border-dashed border-gray-300 bg-gray-50 p-5">
      <ModuleIcon module={module} active={false} muted />
      <div className="min-w-0 flex-1">
        <div className="flex min-h-6 flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-semibold text-gray-600">
            {t(`featureHub.modules.${module.id}.name`)}
          </h2>
          <span className="rounded-md bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold text-gray-600">
            {t("featureHub.copy.unavailable")}
          </span>
        </div>
        <p className="mt-1 text-[13px] leading-5 text-gray-500">
          {t(`featureHub.modules.${module.id}.description`)}
        </p>
        <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-gray-500">
          <InformationCircleIcon className="h-3.5 w-3.5 shrink-0" />
          {t("featureHub.copy.currentlyUnavailable")}
        </p>
        <CategoryTag t={t} module={module} className="mt-2.5" />
      </div>
    </article>
  );
}

function NewBadge({ t }: { t: Translate }) {
  return (
    <span className="shrink-0 rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
      {t("featureHub.copy.new")}
    </span>
  );
}

function CategoryTag({
  t,
  module,
  className,
}: {
  t: Translate;
  module: FeatureModule;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-block rounded-md bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600",
        className,
      )}
    >
      {t(`featureHub.category.${module.category}`)}
    </span>
  );
}

function ToggleSwitch({
  checked,
  disabled,
  ariaLabel,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary-600" : "bg-gray-300",
      )}
    >
      <span
        className={cx(
          "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function ModuleIcon({
  module,
  active,
  muted = false,
}: {
  module: FeatureModule;
  active: boolean;
  muted?: boolean;
}) {
  const Icon = module.icon;
  return (
    <div
      className={cx(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border",
        active
          ? "border-primary-200 bg-primary-50 text-primary-700"
          : cx("border-gray-200 bg-gray-50", muted ? "text-gray-400" : "text-gray-600"),
      )}
    >
      <Icon className="h-5 w-5" />
    </div>
  );
}

function NavigationPreview({ t, activeModuleIds }: { t: Translate; activeModuleIds: string[] }) {
  const groups = PREVIEW_PRODUCTS.map((product) => {
    const modules = activeNavModules(product, activeModuleIds);
    const core = CORE_NAV_ITEMS[product];
    const at = FEATURE_MODULE_NAV_INDEX[product];
    const coreItem = ({ label, href }: { label: string; href: string }) => ({
      key: `core:${href}`,
      label,
      isModule: false,
    });
    return {
      product,
      items: [
        ...core.slice(0, at).map(coreItem),
        ...modules.map((module) => ({
          key: `module:${module.id}`,
          label: module.navItem!.label,
          isModule: true,
        })),
        ...core.slice(at).map(coreItem),
      ],
      moduleCount: modules.length,
    };
  });

  return (
    <section
      aria-labelledby="feature-hub-navigation-preview"
      className="rounded-lg border border-gray-200 bg-white"
    >
      <div className="border-b border-gray-100 px-4 py-3">
        <h2 id="feature-hub-navigation-preview" className="text-[14px] font-semibold text-gray-900">
          {t("featureHub.copy.navigation")}
        </h2>
        <p className="mt-0.5 text-xs text-gray-500">{t("admin.livePreview2")}</p>
      </div>
      <div className="p-3">
        {groups.map((group, index) => (
          <div
            key={group.product}
            className={cx(index > 0 && "mt-3 border-t border-gray-100 pt-3")}
          >
            <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              {t(`featureHub.navigationGroup.${group.product}`)}
            </h3>
            <ol className="space-y-0.5">
              {group.items.map((item) => (
                <li
                  key={item.key}
                  className={cx(
                    "flex h-8 items-center gap-2 rounded-md px-2 text-[13px]",
                    item.isModule
                      ? "bg-primary-50 font-semibold text-primary-700"
                      : "text-gray-500",
                  )}
                >
                  <span
                    className={cx(
                      "shrink-0 rounded-full",
                      item.isModule ? "h-2 w-2 bg-primary-500" : "h-1.5 w-1.5 bg-gray-300",
                    )}
                  />
                  <span className="truncate">{t(`featureHub.navigationItem.${item.label}`)}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}
        <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-3 text-xs font-medium text-gray-500">
          <span>
            {groups.reduce((total, group) => total + group.items.length, 0)}{" "}
            {t("featureHub.copy.items")}
          </span>
          <span>
            {groups.reduce((total, group) => total + group.moduleCount, 0)}{" "}
            {t("featureHub.copy.fromModules")}
          </span>
        </div>
      </div>
    </section>
  );
}

function DetailModal({
  t,
  module,
  isNew,
  error,
  onClose,
  isActive,
  disabled,
  saving,
  onToggle,
}: SwitchProps & {
  t: Translate;
  module: FeatureModule;
  isNew: boolean;
  error: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = `feature-hub-detail-${module.id}`;
  const name = t(`featureHub.modules.${module.id}.name`);
  const Icon = module.icon;

  useEffect(() => {
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) || [],
      ).filter(
        (element) => !element.hasAttribute("disabled") && !element.getAttribute("aria-hidden"),
      );

      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    closeButtonRef.current?.focus();
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousActiveElement?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/35 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[100dvh] w-full overflow-y-auto rounded-t-2xl bg-white p-6 shadow-2xl sm:max-h-[92vh] sm:max-w-xl sm:rounded-2xl"
      >
        {error && (
          <div
            role="alert"
            className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800"
          >
            {error}
          </div>
        )}
        <div className="flex items-start gap-3.5">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[10px] bg-primary-50 text-primary-700">
            <Icon className="h-[22px] w-[22px]" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id={titleId} className="text-xl font-semibold text-gray-950">
                {name}
              </h2>
              {isNew && <NewBadge t={t} />}
            </div>
            <p className="mt-0.5 text-sm text-gray-500">
              {t(`featureHub.modules.${module.id}.description`)}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label={t("featureHub.copy.close")}
            title={t("featureHub.copy.close")}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <p className="mt-5 text-[15px] leading-6 text-gray-800">
          {t(`featureHub.modules.${module.id}.detail`)}
        </p>
        <ul className="mt-4 space-y-2.5">
          {Array.from({ length: module.points }, (_, index) => (
            <li key={index} className="flex items-start gap-2.5 text-sm text-gray-600">
              <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary-600" strokeWidth={2} />
              {t(`featureHub.modules.${module.id}.point.${index}`)}
            </li>
          ))}
        </ul>
        {module.offNote && (
          <p className="mt-4 flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-[13px] leading-5 text-gray-600">
            <InformationCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
            {t(`featureHub.modules.${module.id}.offNote`)}
          </p>
        )}

        <div className="mt-5 flex items-center gap-3 border-t border-gray-200 pt-4">
          <CategoryTag t={t} module={module} />
          <span className="ml-auto text-[13px] font-medium text-gray-600">
            {isActive ? t("featureHub.copy.active") : t("featureHub.copy.inactive")}
          </span>
          <ToggleSwitch
            checked={isActive}
            disabled={disabled || saving}
            ariaLabel={t("admin.actionName", {
              action: isActive ? t("featureHub.copy.deactivate") : t("admin.activate"),
              name,
            })}
            onChange={onToggle}
          />
        </div>
      </div>
    </div>
  );
}

export const featureHubMessages = {
  "featureHub.activated": "{name} activated.",
  "featureHub.deactivated": "{name} deactivated.",
  "featureHub.copy.couldNotLoadModules": "Could not load modules. Please retry.",
  "featureHub.copy.couldNotUpdateModuleActivation": "Could not update module activation.",
  "featureHub.copy.deactivate": "Deactivate",
  "admin.activate": "Activate",
  "admin.actionName": "{action} {name}",
  "admin.livePreview2": "Live preview",
  "featureHub.copy.featureHub": "Feature Hub",
  "featureHub.copy.activatePropertyModulesAndKeepNavigationFocusedOnTheTools":
    "Activate property modules and keep navigation focused on the tools your team uses.",
  "featureHub.copy.ofTotalActive": "/ {total} active",
  "featureHub.copy.disabledModulesStayHidden":
    "Disabled modules stay hidden from the sidebar. Their data is preserved and reappears when you reactivate them.",
  "featureHub.copy.unavailable": "Unavailable",
  "featureHub.copy.currentlyUnavailable": "This feature is currently unavailable.",
  "featureHub.copy.navigation": "Navigation",
  "featureHub.copy.items": "items",
  "featureHub.copy.fromModules": "from modules",
  "featureHub.copy.active": "Active",
  "featureHub.copy.inactive": "Inactive",
  "featureHub.copy.syncing": "Syncing",
  "featureHub.copy.loadingModules": "Loading modules...",
  "featureHub.copy.new": "NEW",
  "featureHub.copy.close": "Close",
  "featureHub.category.Guest": "Guest",
  "featureHub.category.Revenue": "Revenue",
  "featureHub.navigationGroup.pms": "PMS",
  "featureHub.navigationGroup.booking_engine": "Booking Engine",
  "featureHub.navigationItem.Dashboard": "Dashboard",
  "featureHub.navigationItem.Calendar": "Calendar",
  "featureHub.navigationItem.Reservations": "Reservations",
  "featureHub.navigationItem.Inbox": "Inbox",
  "featureHub.navigationItem.Reviews": "Reviews",
  "featureHub.navigationItem.Financials": "Financials",
  "featureHub.navigationItem.Rooms & Rates": "Rooms & Rates",
  "featureHub.navigationItem.Channel Manager": "Channel Manager",
  "featureHub.navigationItem.Settings": "Settings",
  "featureHub.navigationItem.Design Studio": "Design Studio",
  "featureHub.navigationItem.Add-ons": "Add-ons",
  "featureHub.navigationItem.Promos": "Promos",
  // Module copy (VAY-2200). It says only what the product does today.
  "featureHub.modules.inbox.name": "Inbox",
  "featureHub.modules.inbox.description": "Unified guest conversations across channels.",
  "featureHub.modules.inbox.detail":
    "Inbox brings guest messages from Airbnb, Booking.com and email into one place, so your team never misses a conversation. Assign threads and reply with saved quick replies.",
  "featureHub.modules.inbox.point.0": "All channels in one thread view",
  "featureHub.modules.inbox.point.1": "Assign conversations to team members",
  "featureHub.modules.inbox.point.2": "Shared quick replies",
  "featureHub.modules.inbox.point.3": "Unread conversations at a glance",
  "featureHub.modules.reviews.name": "Reviews",
  "featureHub.modules.reviews.description":
    "View and manage guest reviews from connected channels.",
  "featureHub.modules.reviews.detail":
    "See reviews from Booking.com, Airbnb and direct guests in one place, and reply where the channel allows it.",
  "featureHub.modules.reviews.point.0": "All channel reviews in one view",
  "featureHub.modules.reviews.point.1": "Reply to reviews",
  "featureHub.modules.reviews.point.2": "Collect reviews from direct guests after their stay",
  "featureHub.modules.financials.name": "Financials",
  "featureHub.modules.financials.description":
    "Revenue, expenses and profit and loss for your property.",
  "featureHub.modules.financials.detail":
    "Review your property's finances in one place: stay revenue by channel, manual and generated expenses, and reports you can export.",
  "featureHub.modules.financials.point.0": "Stay revenue and channel attribution",
  "featureHub.modules.financials.point.1": "Manual and generated expenses",
  "featureHub.modules.financials.point.2": "Reports and operational folios to export",
  "featureHub.modules.add-ons.name": "Add-ons",
  "featureHub.modules.add-ons.description": "Sell experiences and extras during booking.",
  "featureHub.modules.add-ons.detail":
    "Offer guests extras like airport transfers, breakfast, spa treatments and activities while they book.",
  "featureHub.modules.add-ons.point.0": "Add-ons in several categories",
  "featureHub.modules.add-ons.point.1": "Per-stay and per-night pricing",
  "featureHub.modules.add-ons.point.2": "An extras step in the guest booking flow",
  "featureHub.modules.promos.name": "Promos",
  "featureHub.modules.promos.description": "Promo codes and automatic promotions.",
  "featureHub.modules.promos.detail":
    "Create discount codes guests enter at checkout, and last-minute deals that apply without a code.",
  "featureHub.modules.promos.point.0": "Promo codes with usage limits",
  "featureHub.modules.promos.point.1": "Last-minute discounts",
  "featureHub.modules.promos.point.2": "Room and stay-date targeting",
  "featureHub.modules.promos.offNote":
    "Turning Promos off hides the promo code field from guests and the Promos page from the menu. Last-minute discounts keep running: switch them off on the Promos page first if you don't want them.",
  "featureHub.modules.affiliates.name": "Affiliate Tracking",
  "featureHub.modules.affiliates.description":
    "Track referrals and partner bookings, including the Refer a Guest button.",
};

function defaultTranslate(key: string, params?: Record<string, string | number>): string {
  let text = featureHubMessages[key as keyof typeof featureHubMessages] ?? key;
  for (const [name, value] of Object.entries(params ?? {}))
    text = text.split(`{${name}}`).join(String(value));
  return text;
}
