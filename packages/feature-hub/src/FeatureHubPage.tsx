"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowPathIcon,
  BoltIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  MagnifyingGlassIcon,
  PowerIcon,
  SparklesIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";

import {
  activeModuleCount,
  activeNavModules,
  CORE_NAV_ITEMS,
  FEATURE_CATEGORIES,
  FEATURE_MODULES,
  modulesForProduct,
} from "./registry";
import type {
  FeatureActivationClient,
  FeatureCategory,
  FeatureModule,
  FeatureProduct,
} from "./types";
import { useFeatureModuleActivations } from "./useFeatureModuleActivations";

interface FeatureHubPageProps {
  activationClient: FeatureActivationClient;
  initialProduct?: FeatureProduct;
}

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const PRODUCT_LABELS: Record<FeatureProduct, string> = {
  pms: "PMS Modules",
  booking_engine: "Booking Engine Modules",
};

const PRODUCT_PREVIEW_LABELS: Record<FeatureProduct, string> = {
  pms: "PMS navigation",
  booking_engine: "Booking Engine navigation",
};

export function FeatureHubPage({ activationClient, initialProduct = "pms" }: FeatureHubPageProps) {
  const [product, setProduct] = useState<FeatureProduct>(initialProduct);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"All" | FeatureCategory>("All");
  const [selectedModule, setSelectedModule] = useState<FeatureModule | null>(null);
  const [notice, setNotice] = useState("");
  const [savingModuleId, setSavingModuleId] = useState<string | null>(null);
  const { activeModuleIds, activeModuleSet, loading, error, setModuleActive } =
    useFeatureModuleActivations(activationClient);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(""), 3800);
    return () => window.clearTimeout(id);
  }, [notice]);

  const combinedActiveCount = useMemo(
    () => FEATURE_MODULES.filter((module) => activeModuleSet.has(module.id)).length,
    [activeModuleSet],
  );

  const filteredModules = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return modulesForProduct(product).filter((module) => {
      const matchesCategory = category === "All" || module.category === category;
      const matchesSearch =
        !normalized ||
        [module.name, module.description, module.category]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      return matchesCategory && matchesSearch;
    });
  }, [category, product, query]);

  const toggleModule = async (module: FeatureModule, isActive: boolean) => {
    if (!isActive) {
      const message =
        module.category === "Payments"
          ? `Disabling ${module.name} will prevent new ${module.name} payments. Existing bookings are unaffected. Continue?`
          : module.navItem
            ? `Deactivating ${module.name} hides it from your navigation. Your data is preserved and will be available if you reactivate. Continue?`
            : `Deactivating ${module.name} hides its setup controls. Existing data is preserved. Continue?`;
      if (!window.confirm(message)) return;
    }

    setSavingModuleId(module.id);
    try {
      await setModuleActive(module.id, isActive);
      setNotice(
        isActive && module.settingsNote
          ? `Activated. ${module.settingsNote}`
          : `${module.name} ${isActive ? "activated" : "deactivated"}.`,
      );
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not update module activation.");
    } finally {
      setSavingModuleId(null);
    }
  };

  const clearSearch = () => setQuery("");

  return (
    <div className="min-h-full bg-[#f7f7f4] text-gray-950">
      <div className="mx-auto max-w-[1480px] px-4 py-5 sm:px-6 lg:px-8">
        <header className="mb-5 flex flex-col gap-3 border-b border-stone-200 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-emerald-600 text-white shadow-sm">
                <BoltIcon className="h-4 w-4" />
              </span>
              <span className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
                <CheckCircleIcon className="h-3.5 w-3.5" />
                {combinedActiveCount} active
              </span>
              {loading && (
                <span className="inline-flex items-center gap-1 rounded-md border border-stone-200 bg-white px-2 py-1 text-xs font-medium text-stone-500">
                  <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                  Syncing
                </span>
              )}
            </div>
            <h1 className="text-2xl font-semibold tracking-normal text-gray-950 sm:text-3xl">
              Feature Hub
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-stone-600">
              Activate modules to add them to your property. Your navigation adapts automatically.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            {(Object.keys(PRODUCT_LABELS) as FeatureProduct[]).map((key) => {
              const count = activeModuleCount(key, activeModuleIds);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setProduct(key)}
                  className={cx(
                    "inline-flex min-h-10 items-center justify-center rounded-md border px-3 text-sm font-semibold transition-colors",
                    product === key
                      ? "border-gray-950 bg-gray-950 text-white"
                      : "border-stone-300 bg-white text-stone-700 hover:border-stone-500",
                  )}
                >
                  {PRODUCT_LABELS[key]}{" "}
                  <span className="ml-1 text-xs opacity-75">· {count} active</span>
                </button>
              );
            })}
          </div>
        </header>

        {error && (
          <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {error}
          </div>
        )}
        {notice && (
          <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">
            {notice}
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]">
          <main className="min-w-0">
            <div className="mb-4 flex flex-col gap-3">
              <label className="relative block">
                <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search modules..."
                  className="h-11 w-full rounded-md border border-stone-300 bg-white pl-9 pr-9 text-sm outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                />
                {query && (
                  <button
                    type="button"
                    onClick={clearSearch}
                    aria-label="Clear search"
                    title="Clear search"
                    className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-900"
                  >
                    <XMarkIcon className="h-4 w-4" />
                  </button>
                )}
              </label>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {FEATURE_CATEGORIES.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setCategory(item)}
                    className={cx(
                      "h-9 shrink-0 rounded-md border px-3 text-sm font-medium transition-colors",
                      category === item
                        ? "border-emerald-600 bg-emerald-600 text-white"
                        : "border-stone-300 bg-white text-stone-700 hover:border-stone-500",
                    )}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>

            {filteredModules.length === 0 ? (
              <div className="rounded-md border border-dashed border-stone-300 bg-white px-5 py-12 text-center">
                <SparklesIcon className="mx-auto h-8 w-8 text-stone-400" />
                <p className="mt-3 text-sm font-semibold text-stone-900">
                  {query ? `No modules match "${query}"` : "No modules in this category."}
                </p>
                {query && (
                  <button
                    type="button"
                    onClick={clearSearch}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-stone-700 hover:border-stone-500"
                  >
                    <XMarkIcon className="h-4 w-4" />
                    Clear search
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
                {filteredModules.map((module) => (
                  <ModuleCard
                    key={module.id}
                    module={module}
                    isActive={activeModuleSet.has(module.id)}
                    saving={savingModuleId === module.id}
                    onOpen={() => setSelectedModule(module)}
                    onToggle={(isActive) => toggleModule(module, isActive)}
                  />
                ))}
              </div>
            )}
          </main>

          <aside className="lg:sticky lg:top-4 lg:self-start">
            <NavigationPreview product={product} activeModuleIds={activeModuleIds} />
          </aside>
        </div>
      </div>

      {selectedModule && (
        <DetailModal
          module={selectedModule}
          isActive={activeModuleSet.has(selectedModule.id)}
          saving={savingModuleId === selectedModule.id}
          onClose={() => setSelectedModule(null)}
          onToggle={(isActive) => toggleModule(selectedModule, isActive)}
        />
      )}
    </div>
  );
}

function ModuleCard({
  module,
  isActive,
  saving,
  onOpen,
  onToggle,
}: {
  module: FeatureModule;
  isActive: boolean;
  saving: boolean;
  onOpen: () => void;
  onToggle: (isActive: boolean) => void;
}) {
  return (
    <article
      className={cx(
        "group relative min-h-[190px] rounded-md border bg-white p-4 shadow-sm transition",
        isActive
          ? "border-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.14)]"
          : "border-stone-200 hover:border-stone-400",
      )}
    >
      <button
        type="button"
        aria-label={`View ${module.name} details`}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
        className="absolute inset-0 z-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
      />
      <div className="pointer-events-none relative z-10 mb-4 flex items-start justify-between gap-3">
        <ModuleIcon module={module} active={isActive} />
        <div className="pointer-events-auto">
          <ToggleSwitch
            checked={isActive}
            disabled={saving}
            onClick={(event) => event.stopPropagation()}
            onChange={(checked) => onToggle(checked)}
          />
        </div>
      </div>
      <div className="pointer-events-none relative z-10 min-w-0">
        <div className="flex min-h-6 items-center gap-2">
          <h2 className="truncate text-base font-semibold text-gray-950">{module.name}</h2>
          {module.isNew && (
            <span className="shrink-0 rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
              NEW
            </span>
          )}
        </div>
        <p className="mt-1 line-clamp-2 text-sm leading-5 text-stone-600">{module.description}</p>
      </div>
      <div className="pointer-events-none relative z-10 mt-4 flex flex-wrap gap-1.5">
        <span className="rounded-md bg-stone-100 px-2 py-1 text-xs font-medium text-stone-700">
          {module.category}
        </span>
        {module.type === "external" && (
          <span className="rounded-md bg-sky-50 px-2 py-1 text-xs font-medium text-sky-700">
            External
          </span>
        )}
      </div>
    </article>
  );
}

function ToggleSwitch({
  checked,
  disabled,
  onClick,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event);
        onChange(!checked);
      }}
      className={cx(
        "relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:cursor-wait disabled:opacity-60",
        checked ? "border-emerald-600 bg-emerald-600" : "border-stone-300 bg-stone-100",
      )}
    >
      <span
        className={cx(
          "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-6" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function ModuleIcon({ module, active }: { module: FeatureModule; active: boolean }) {
  if (module.type === "external") {
    return (
      <div
        className={cx(
          "flex h-11 w-11 items-center justify-center rounded-md border text-sm font-black",
          active
            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
            : "border-stone-200 bg-stone-50 text-stone-700",
        )}
      >
        <BrandMark id={module.icon} />
      </div>
    );
  }
  const icons = {
    chart: ChartGlyph,
    chat: ChatGlyph,
    users: UsersGlyph,
  };
  const Icon = icons[module.icon as keyof typeof icons] || ChatGlyph;
  return (
    <div
      className={cx(
        "flex h-11 w-11 items-center justify-center rounded-md border",
        active
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-stone-200 bg-stone-50 text-stone-600",
      )}
    >
      <Icon className="h-5 w-5" />
    </div>
  );
}

function BrandMark({ id }: { id: string }) {
  if (id === "stripe") return <span className="text-[15px] tracking-normal">S</span>;
  if (id === "paypal") return <span className="text-[15px] tracking-normal">P</span>;
  if (id === "xendit") return <span className="text-[12px] tracking-normal">XDT</span>;
  if (id === "lodgify") return <span className="text-[12px] tracking-normal">LDG</span>;
  return <span className="text-[12px] tracking-normal">{id.slice(0, 3).toUpperCase()}</span>;
}

function NavigationPreview({
  product,
  activeModuleIds,
}: {
  product: FeatureProduct;
  activeModuleIds: string[];
}) {
  const navModules = activeNavModules(product, activeModuleIds);
  const active = new Set(activeModuleIds);
  const nonNavActive = modulesForProduct(product).filter(
    (module) => active.has(module.id) && !module.navItem && module.settingsNote,
  );
  const totalItems = CORE_NAV_ITEMS[product].length + navModules.length;

  return (
    <section className="rounded-md border border-stone-200 bg-white shadow-sm">
      <button
        type="button"
        className="flex w-full items-center justify-between border-b border-stone-200 px-4 py-3 text-left lg:pointer-events-none"
      >
        <div>
          <h2 className="text-sm font-semibold text-gray-950">{PRODUCT_PREVIEW_LABELS[product]}</h2>
          <p className="mt-0.5 text-xs text-stone-500">Live preview</p>
        </div>
        <ChevronDownIcon className="h-4 w-4 text-stone-400 lg:hidden" />
      </button>
      <div className="p-3">
        <div className="space-y-1.5">
          {CORE_NAV_ITEMS[product].map((item) => (
            <div
              key={item.href}
              className="flex h-9 items-center gap-2 rounded-md px-2 text-sm text-stone-500"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-stone-300" />
              <span className="truncate">{item.label}</span>
            </div>
          ))}
          {navModules.map((module) => (
            <div
              key={module.id}
              className="flex h-9 items-center gap-2 rounded-md bg-emerald-50 px-2 text-sm font-semibold text-emerald-700"
            >
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="truncate">{module.navItem?.label}</span>
            </div>
          ))}
        </div>
        {nonNavActive.length > 0 && (
          <div className="mt-4 space-y-2 border-t border-stone-200 pt-3">
            {nonNavActive.map((module) => (
              <div key={module.id} className="rounded-md bg-sky-50 px-3 py-2 text-xs text-sky-800">
                <span className="font-semibold">{module.name}</span>: {module.settingsNote}
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 flex items-center justify-between border-t border-stone-200 pt-3 text-xs font-semibold text-stone-500">
          <span>{totalItems} items</span>
          <span>{navModules.length} module items</span>
        </div>
      </div>
    </section>
  );
}

function DetailModal({
  module,
  isActive,
  saving,
  onClose,
  onToggle,
}: {
  module: FeatureModule;
  isActive: boolean;
  saving: boolean;
  onClose: () => void;
  onToggle: (isActive: boolean) => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = `feature-hub-detail-${module.id}`;

  useEffect(() => {
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

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
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[100dvh] w-full flex-col overflow-hidden rounded-t-md bg-white shadow-2xl sm:max-h-[92vh] sm:max-w-3xl sm:rounded-md"
      >
        <div className="flex items-start gap-3 border-b border-stone-200 px-4 py-4 sm:px-5">
          <ModuleIcon module={module} active={isActive} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id={titleId} className="text-xl font-semibold text-gray-950">
                {module.name}
              </h2>
              {module.isNew && (
                <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                  NEW
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <span className="rounded-md bg-stone-100 px-2 py-1 text-xs font-medium text-stone-700">
                {module.category}
              </span>
              {module.type === "external" && (
                <span className="rounded-md bg-sky-50 px-2 py-1 text-xs font-medium text-sky-700">
                  External integration
                </span>
              )}
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-900"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-4 sm:px-5">
          <p className="text-base font-medium leading-7 text-gray-900">{module.detail.headline}</p>
          <div className="mt-4 overflow-hidden rounded-md border border-stone-200 bg-stone-50">
            <ModuleVisual type={module.detail.visualType} />
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {module.detail.features.map((feature) => (
              <div
                key={feature.text}
                className="flex min-h-14 items-start gap-2 rounded-md border border-stone-200 bg-white p-3"
              >
                <feature.icon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                <p className="text-sm leading-5 text-stone-700">{feature.text}</p>
              </div>
            ))}
          </div>
          {isActive && (
            <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Deactivating hides this module from navigation or settings. Your data is preserved and
              will be available if you reactivate.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-stone-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="flex items-center gap-3">
            <ToggleSwitch checked={isActive} disabled={saving} onChange={onToggle} />
            <span className="text-sm font-semibold text-stone-700">
              {isActive ? "Active" : "Inactive"}
            </span>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={() => onToggle(!isActive)}
            className={cx(
              "inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition disabled:cursor-wait disabled:opacity-60",
              isActive
                ? "border border-stone-300 bg-white text-stone-700 hover:border-stone-500"
                : "bg-emerald-600 text-white hover:bg-emerald-700",
            )}
          >
            <PowerIcon className="h-4 w-4" />
            {isActive ? "Deactivate" : "Activate Module"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModuleVisual({ type }: { type: FeatureModule["detail"]["visualType"] }) {
  if (type === "financials") return <FinancialsVisual />;
  if (type === "affiliates") return <AffiliatesVisual />;
  if (type === "stripe") return <StripeVisual />;
  if (type === "paypal") return <PayPalVisual />;
  if (type === "xendit") return <XenditVisual />;
  if (type === "lodgify") return <LodgifyVisual />;
  return <InboxVisual />;
}

function InboxVisual() {
  const rows = [
    ["Booking.com", "Marta Silva", "Can we arrive at 21:30?", "08:42"],
    ["Airbnb", "Jon Keller", "Thanks, parking looks good.", "09:18"],
    ["Email", "Ari Putra", "Do you offer airport pickup?", "10:04"],
  ];
  return (
    <svg viewBox="0 0 760 300" className="h-auto w-full" role="img" aria-label="Inbox preview">
      <rect width="760" height="300" fill="#f8faf8" />
      <rect x="34" y="34" width="692" height="232" rx="10" fill="#fff" stroke="#d6d3d1" />
      <rect x="56" y="58" width="156" height="180" rx="8" fill="#f0fdf4" />
      <rect x="72" y="78" width="88" height="12" rx="6" fill="#16a34a" />
      <rect x="72" y="112" width="126" height="8" rx="4" fill="#bbf7d0" />
      <rect x="72" y="136" width="104" height="8" rx="4" fill="#bbf7d0" />
      {rows.map((row, index) => {
        const y = 62 + index * 64;
        return (
          <g key={row[1]}>
            <rect
              x="236"
              y={y}
              width="454"
              height="48"
              rx="8"
              fill={index === 0 ? "#ecfdf5" : "#fff"}
              stroke="#e7e5e4"
            />
            <circle cx="258" cy={y + 24} r="8" fill={index === 0 ? "#10b981" : "#a8a29e"} />
            <text x="278" y={y + 20} fontSize="12" fontWeight="700" fill="#111827">
              {row[1]}
            </text>
            <text x="278" y={y + 36} fontSize="10" fill="#78716c">
              {row[2]}
            </text>
            <rect x="560" y={y + 13} width="76" height="18" rx="9" fill="#e0f2fe" />
            <text x="574" y={y + 26} fontSize="9" fontWeight="700" fill="#0369a1">
              {row[0]}
            </text>
            <text x="650" y={y + 26} fontSize="10" fill="#78716c">
              {row[3]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function FinancialsVisual() {
  const bars = [64, 92, 74, 128, 104, 148, 118, 168, 134, 184, 158, 204];
  return (
    <svg viewBox="0 0 760 300" className="h-auto w-full" role="img" aria-label="Financials preview">
      <rect width="760" height="300" fill="#f8faf8" />
      {["RevPAR", "ADR", "Occupancy", "Revenue"].map((label, index) => (
        <g key={label}>
          <rect
            x={34 + index * 178}
            y="34"
            width="154"
            height="74"
            rx="9"
            fill="#fff"
            stroke="#d6d3d1"
          />
          <text x={50 + index * 178} y="62" fontSize="11" fill="#78716c">
            {label}
          </text>
          <text x={50 + index * 178} y="88" fontSize="23" fontWeight="700" fill="#111827">
            {index === 2 ? "79%" : index === 3 ? "42k" : `${110 + index * 24}`}
          </text>
          <text x={125 + index * 178} y="88" fontSize="11" fontWeight="700" fill="#16a34a">
            +{index + 3}%
          </text>
        </g>
      ))}
      <rect x="34" y="132" width="692" height="230" rx="10" fill="#fff" stroke="#d6d3d1" />
      {bars.map((height, index) => (
        <rect
          key={index}
          x={62 + index * 54}
          y={260 - height}
          width="28"
          height={height}
          rx="5"
          fill={index > 8 ? "#10b981" : "#a7f3d0"}
        />
      ))}
      <path
        d="M56 220 C160 192 214 210 300 172 C390 132 446 164 520 118 C590 76 646 110 702 64"
        fill="none"
        stroke="#0369a1"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AffiliatesVisual() {
  const rows = [
    ["Bali Stay Guide", "1,248", "36", "EUR 9,420", "EUR 471"],
    ["Surf School Co", "642", "18", "EUR 4,820", "EUR 241"],
    ["Villa Concierge", "388", "11", "EUR 3,104", "EUR 155"],
  ];
  return (
    <svg viewBox="0 0 760 300" className="h-auto w-full" role="img" aria-label="Affiliates preview">
      <rect width="760" height="300" fill="#f8faf8" />
      <rect x="38" y="40" width="684" height="220" rx="10" fill="#fff" stroke="#d6d3d1" />
      <rect x="60" y="66" width="640" height="34" rx="6" fill="#f5f5f4" />
      {["Partner", "Clicks", "Bookings", "Revenue", "Commission"].map((label, index) => (
        <text
          key={label}
          x={[78, 286, 388, 504, 620][index]}
          y="88"
          fontSize="11"
          fontWeight="700"
          fill="#57534e"
        >
          {label}
        </text>
      ))}
      {rows.map((row, index) => {
        const y = 122 + index * 48;
        return (
          <g key={row[0]}>
            <rect
              x="60"
              y={y - 22}
              width="640"
              height="44"
              rx="6"
              fill={index === 0 ? "#ecfdf5" : "#fff"}
              stroke="#e7e5e4"
            />
            {row.map((value, column) => (
              <text
                key={value}
                x={[78, 286, 388, 504, 620][column]}
                y={y + 5}
                fontSize="12"
                fontWeight={column === 0 ? "700" : "500"}
                fill={column === 4 ? "#047857" : "#111827"}
              >
                {value}
              </text>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

function StripeVisual() {
  return (
    <PaymentVisual brand="Stripe" accent="#635bff" labels={["Visa", "MC", "Amex", "Apple Pay"]} />
  );
}

function PayPalVisual() {
  return (
    <PaymentVisual
      brand="PayPal"
      accent="#0070ba"
      labels={["PayPal", "Balance", "Card", "Buyer"]}
    />
  );
}

function XenditVisual() {
  return <PaymentVisual brand="Xendit" accent="#7c3aed" labels={["BCA", "BNI", "BRI", "OVO"]} />;
}

function PaymentVisual({
  brand,
  accent,
  labels,
}: {
  brand: string;
  accent: string;
  labels: string[];
}) {
  return (
    <svg
      viewBox="0 0 760 300"
      className="h-auto w-full"
      role="img"
      aria-label={`${brand} payment preview`}
    >
      <rect width="760" height="300" fill="#f8faf8" />
      <rect x="48" y="52" width="220" height="178" rx="12" fill="#fff" stroke="#d6d3d1" />
      <text x="72" y="92" fontSize="27" fontWeight="800" fill={accent}>
        {brand}
      </text>
      <rect x="72" y="122" width="148" height="34" rx="17" fill={accent} opacity="0.92" />
      <text x="104" y="145" fontSize="12" fontWeight="700" fill="#fff">
        Pay now
      </text>
      <text x="72" y="188" fontSize="12" fill="#78716c">
        Settlement profile
      </text>
      <rect x="72" y="202" width="128" height="8" rx="4" fill="#d6d3d1" />
      <rect x="310" y="52" width="404" height="178" rx="12" fill="#fff" stroke="#d6d3d1" />
      <path
        d="M342 144 H442 L486 96 H588 L636 144 H682"
        fill="none"
        stroke={accent}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {labels.map((label, index) => (
        <g key={label}>
          <rect
            x={342 + index * 84}
            y="170"
            width="66"
            height="34"
            rx="7"
            fill="#f5f5f4"
            stroke="#e7e5e4"
          />
          <text x={360 + index * 84} y="192" fontSize="11" fontWeight="700" fill="#44403c">
            {label}
          </text>
        </g>
      ))}
      <text x="342" y="82" fontSize="12" fontWeight="700" fill="#111827">
        Payment flow
      </text>
      <text x="342" y="238" fontSize="11" fill="#78716c">
        Fees and availability are configured after activation.
      </text>
    </svg>
  );
}

function LodgifyVisual() {
  return (
    <svg
      viewBox="0 0 760 300"
      className="h-auto w-full"
      role="img"
      aria-label="Lodgify sync preview"
    >
      <rect width="760" height="300" fill="#f8faf8" />
      <rect x="62" y="86" width="210" height="124" rx="12" fill="#fff" stroke="#d6d3d1" />
      <text x="96" y="132" fontSize="26" fontWeight="800" fill="#0f766e">
        Lodgify
      </text>
      <rect x="98" y="154" width="124" height="10" rx="5" fill="#ccfbf1" />
      <rect x="98" y="176" width="92" height="10" rx="5" fill="#ccfbf1" />
      <rect x="488" y="86" width="210" height="124" rx="12" fill="#fff" stroke="#d6d3d1" />
      <text x="540" y="132" fontSize="26" fontWeight="800" fill="#047857">
        Vayada
      </text>
      <rect x="528" y="154" width="124" height="10" rx="5" fill="#bbf7d0" />
      <rect x="528" y="176" width="92" height="10" rx="5" fill="#bbf7d0" />
      <path
        d="M292 126 C354 78 432 78 468 126"
        fill="none"
        stroke="#0f766e"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path
        d="M468 174 C404 222 338 222 292 174"
        fill="none"
        stroke="#10b981"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <polygon points="462,118 482,126 462,136" fill="#0f766e" />
      <polygon points="298,166 278,174 298,184" fill="#10b981" />
      <text x="338" y="144" fontSize="12" fontWeight="700" fill="#44403c">
        Rooms, rates, availability
      </text>
      <text x="348" y="168" fontSize="12" fontWeight="700" fill="#44403c">
        Bookings and updates
      </text>
    </svg>
  );
}

function ChatGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M4 5h16v11H8l-4 4V5Z" />
      <path d="M8 9h8M8 12h5" />
    </svg>
  );
}

function ChartGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M4 19V5M4 19h16" />
      <path d="M8 16v-5M12 16V8M16 16v-9" />
    </svg>
  );
}

function UsersGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM3 21a6 6 0 0 1 12 0" />
      <path d="M16 8a3 3 0 1 1 0 6M17 17a5 5 0 0 1 4 4" />
    </svg>
  );
}
