"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowPathIcon,
  BuildingOffice2Icon,
  ChartBarIcon,
  CursorArrowRaysIcon,
  PresentationChartLineIcon,
  Squares2X2Icon,
} from "@heroicons/react/24/outline";
import { BarChart, LineChart } from "@/components/Chart";
import { PropertySelector } from "@/components/PropertySelector";
import { authService } from "@/services/auth";
import {
  getGrowthDashboard,
  Granularity,
  GrowthDashboard,
} from "@/services/platformAdmin";

const STORAGE_KEY = "platformAdminGrowthFilters";

const tabs = [
  { name: "Growth", active: true },
  { name: "Bookings", active: false },
  { name: "Properties", active: false },
];

const granularityOptions: Granularity[] = ["daily", "weekly", "monthly"];

export default function DashboardPage() {
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [data, setData] = useState<GrowthDashboard | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [excludeTestData, setExcludeTestData] = useState(true);
  const [granularity, setGranularity] = useState<Granularity>("weekly");
  const [bookingPropertyId, setBookingPropertyId] = useState("");
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const hasLoadedDefaults = useRef(false);

  useEffect(() => {
    if (!authService.isLoggedIn()) {
      window.location.href = "/login";
      return;
    }
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const filters = JSON.parse(stored) as {
          selectedIds?: string[];
          excludeTestData?: boolean;
          granularity?: Granularity;
          bookingPropertyId?: string;
        };
        setSelectedIds(filters.selectedIds || []);
        setExcludeTestData(filters.excludeTestData ?? true);
        setGranularity(filters.granularity || "weekly");
        setBookingPropertyId(filters.bookingPropertyId || "");
      } catch {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    }
    setIsAuthorized(true);
  }, []);

  useEffect(() => {
    if (!isAuthorized) return;
    async function load() {
      setIsLoading(true);
      setError("");
      try {
        const response = await getGrowthDashboard({
          granularity,
          excludeTestData,
          propertyIds:
            selectedIds.length === 0 && !hasLoadedDefaults.current ? undefined : selectedIds,
          bookingPropertyId: bookingPropertyId || undefined,
        });
        hasLoadedDefaults.current = true;
        setData(response);
        if (selectedIds.length === 0 && response.selectedPropertyIds.length > 0) {
          setSelectedIds(response.selectedPropertyIds);
        }
        sessionStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            selectedIds: response.selectedPropertyIds,
            excludeTestData,
            granularity,
            bookingPropertyId: response.bookingPropertyId || "",
          }),
        );
      } catch (err) {
        if (err instanceof Error && err.message.toLowerCase().includes("staff")) {
          setError("Access denied.");
        } else {
          setError(err instanceof Error ? err.message : "Unable to load dashboard.");
        }
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, [bookingPropertyId, excludeTestData, granularity, isAuthorized, selectedIds]);

  const liveProperties = useMemo(
    () => data?.properties.filter((property) => property.status === "live") || [],
    [data],
  );

  if (!isAuthorized) return null;

  return (
    <main className="dashboard-grid min-h-screen bg-bone text-ink">
      <div className="flex min-h-screen">
        <aside className="hidden w-64 shrink-0 border-r border-ink/10 bg-ink px-4 py-5 text-bone lg:block">
          <div className="mb-8 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-bone text-ink">
              <Squares2X2Icon className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-semibold">vayada</p>
              <p className="text-xs text-bone/55">platform admin</p>
            </div>
          </div>
          <nav className="space-y-1">
            {tabs.map((tab) => (
              <button
                key={tab.name}
                type="button"
                className={`flex h-10 w-full items-center rounded-md px-3 text-sm font-medium ${
                  tab.active ? "bg-bone text-ink" : "text-bone/65 hover:bg-bone/10 hover:text-bone"
                }`}
              >
                {tab.name}
              </button>
            ))}
          </nav>
        </aside>

        <section className="min-w-0 flex-1">
          <header className="border-b border-ink/10 bg-bone/85 px-4 py-4 backdrop-blur md:px-6">
            <div className="mx-auto flex max-w-7xl flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">
                  Growth dashboard · Admin · vayada platform
                </p>
                <h1 className="mt-2 text-2xl font-semibold tracking-normal md:text-3xl">
                  Platform growth
                </h1>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-md px-3 py-2 text-sm font-semibold ${
                    excludeTestData ? "bg-reed/15 text-reed" : "bg-brass/20 text-brass"
                  }`}
                >
                  {excludeTestData ? "Showing real bookings only" : "Including test data"}
                </span>
                <button
                  type="button"
                  onClick={() => setExcludeTestData((value) => !value)}
                  className={`flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-semibold ${
                    excludeTestData
                      ? "border-reed/30 bg-white text-reed"
                      : "border-brass/40 bg-white text-brass"
                  }`}
                >
                  <span
                    className={`h-4 w-7 rounded-full p-0.5 ${
                      excludeTestData ? "bg-reed" : "bg-brass"
                    }`}
                  >
                    <span
                      className={`block h-3 w-3 rounded-full bg-white transition ${
                        excludeTestData ? "translate-x-3" : ""
                      }`}
                    />
                  </span>
                  Exclude test data
                </button>
                <button
                  type="button"
                  onClick={() => setSelectorOpen(true)}
                  className="flex h-10 items-center gap-2 rounded-md border border-ink/10 bg-white px-3 text-sm font-semibold hover:border-lagoon hover:text-lagoon"
                >
                  <BuildingOffice2Icon className="h-4 w-4" aria-hidden="true" />
                  Properties ({selectedIds.length})
                </button>
                <button
                  type="button"
                  onClick={() => authService.logout()}
                  className="h-10 rounded-md border border-ink/10 bg-white px-3 text-sm font-semibold text-ink/65 hover:text-ember"
                >
                  Sign out
                </button>
              </div>
              <nav className="flex gap-2 overflow-x-auto lg:hidden" aria-label="Dashboard tabs">
                {tabs.map((tab) => (
                  <button
                    key={tab.name}
                    type="button"
                    className={`h-9 rounded-md px-3 text-sm font-semibold ${
                      tab.active ? "bg-ink text-bone" : "bg-white text-ink/60"
                    }`}
                  >
                    {tab.name}
                  </button>
                ))}
              </nav>
            </div>
          </header>

          <div className="mx-auto max-w-7xl px-4 py-5 md:px-6">
            {error ? (
              <div className="mb-4 rounded-md border border-ember/25 bg-ember/10 px-4 py-3 text-sm font-medium text-ember">
                {error}
              </div>
            ) : null}

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {(data?.metrics || []).map((metric) => (
                <article
                  key={metric.key}
                  className="rounded-lg border border-ink/10 bg-white p-4 shadow-sm"
                >
                  <div className="mb-5 flex items-center justify-between">
                    <p className="text-sm font-medium text-ink/55">{metric.label}</p>
                    <MetricIcon metricKey={metric.key} />
                  </div>
                  <p className="text-3xl font-semibold">{isLoading ? "..." : metric.value}</p>
                  <p className="mt-2 text-sm text-ink/50">{metric.delta?.label || ""}</p>
                </article>
              ))}
            </div>

            <section className="mt-4 rounded-lg border border-ink/10 bg-bone/80 p-3">
              <div className="flex flex-wrap items-center gap-2">
                {granularityOptions.map((option) => (
                  <button
                    type="button"
                    key={option}
                    onClick={() => setGranularity(option)}
                    className={`h-9 rounded-md px-3 text-sm font-semibold capitalize ${
                      granularity === option
                        ? "bg-ink text-bone"
                        : "bg-white text-ink/60 hover:text-ink"
                    }`}
                  >
                    {option}
                  </button>
                ))}
                <select
                  value={bookingPropertyId}
                  onChange={(event) => setBookingPropertyId(event.target.value)}
                  className="ml-auto h-9 min-w-52 rounded-md border border-ink/10 bg-white px-3 text-sm font-medium outline-none"
                  aria-label="Booking requests property"
                >
                  <option value="">All properties</option>
                  {liveProperties.map((property) => (
                    <option key={property.id} value={property.id}>
                      {property.name}
                    </option>
                  ))}
                </select>
              </div>
            </section>

            {data?.emptyMessage ? (
              <div className="mt-4 rounded-md border border-brass/30 bg-brass/10 px-4 py-3 text-sm font-medium text-brass">
                {data.emptyMessage}
              </div>
            ) : null}

            <div className="mt-4 grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
              <ChartPanel
                title="Page views"
                subtitle="All selected properties"
                icon={<PresentationChartLineIcon className="h-5 w-5" aria-hidden="true" />}
              >
                <LineChart points={data?.pageViews || []} />
              </ChartPanel>
              <ChartPanel
                title="Booking requests"
                subtitle={bookingPropertyId ? "Single property drill-down" : "All properties"}
                icon={<ChartBarIcon className="h-5 w-5" aria-hidden="true" />}
              >
                <BarChart points={data?.bookingRequests || []} />
              </ChartPanel>
            </div>

            <div className="mt-4">
              <ChartPanel
                title="Properties going live"
                subtitle="Cumulative live properties"
                icon={<CursorArrowRaysIcon className="h-5 w-5" aria-hidden="true" />}
              >
                <LineChart points={data?.liveProperties || []} tone="brass" />
              </ChartPanel>
            </div>
          </div>
        </section>
      </div>

      <PropertySelector
        open={selectorOpen}
        properties={data?.properties || []}
        selectedIds={selectedIds}
        onApply={(ids) => {
          setSelectedIds(ids);
          setSelectorOpen(false);
        }}
        onClose={() => setSelectorOpen(false)}
      />
    </main>
  );
}

function MetricIcon({ metricKey }: { metricKey: string }) {
  const className = "h-5 w-5";
  if (metricKey === "live_properties") return <BuildingOffice2Icon className={className} />;
  if (metricKey === "page_views") return <PresentationChartLineIcon className={className} />;
  if (metricKey === "booking_requests") return <ChartBarIcon className={className} />;
  return <ArrowPathIcon className={className} />;
}

function ChartPanel({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-ink/10 bg-white/70 p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-ink/50">{subtitle}</p>
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-ink text-bone">
          {icon}
        </div>
      </div>
      {children}
    </section>
  );
}
