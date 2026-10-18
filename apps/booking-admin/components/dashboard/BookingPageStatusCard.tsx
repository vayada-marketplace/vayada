"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRightIcon,
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ExclamationTriangleIcon,
  GlobeAltIcon,
} from "@heroicons/react/24/outline";
import { buildSharedHotelSetupRedirectPath } from "@vayada/product-onboarding";
import type { BookingPublicationReview } from "@vayada/product-onboarding/bookingPublicationReviewApi";
import { useTranslation } from "@/lib/i18n";
import {
  bookingPageStatus,
  type BookingPageItem,
  type BookingPageStatus,
} from "@/lib/utils/bookingPageStatus";
import { ApiErrorResponse } from "@/services/api/client";
import { bookingPublicationApi } from "@/services/api/bookingPublicationClient";
import {
  BookingPropertyLinkClientError,
  getBookingHotelPropertyLink,
} from "@/services/api/bookingPropertyLinkClient";
import {
  getSelectedBookingHotelId,
  SELECTED_HOTEL_CHANGED_EVENT,
} from "@/services/api/bookingHotelScope";

const POLL_INTERVAL_MS = 2000;
const POLL_LIMIT = 15;

/** Shows whether the hotel's booking page is online and publishes it the first time (VAY-2187). */
export function BookingPageStatusCard() {
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [review, setReview] = useState<BookingPublicationReview | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [noAccess, setNoAccess] = useState(false);
  const [publishFailed, setPublishFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [polls, setPolls] = useState(0);
  const active = useRef(false);
  const mounted = useRef(true);
  const propertyIdRef = useRef<string | null>(null);

  const load = useCallback(async (id: string) => {
    const next = await bookingPublicationApi.load(id);
    if (mounted.current) setReview(next);
    return next;
  }, []);

  const refresh = useCallback(async () => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setLoadFailed(false);
    try {
      let id = propertyIdRef.current;
      if (!id) {
        const hotelId = getSelectedBookingHotelId();
        if (!hotelId) return;
        id = (await getBookingHotelPropertyLink({ hotelId })).propertyId;
        propertyIdRef.current = id;
        if (mounted.current) setPropertyId(id);
      }
      await load(id);
    } catch (error) {
      if (!mounted.current) return;
      // Without booking settings access or a Booking property there is nothing to show or publish.
      if (isAccessError(error)) setNoAccess(true);
      else setLoadFailed(true);
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [load]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // With several hotels the header may store the selection after this card mounted.
    const onSelected = () => {
      if (!propertyIdRef.current) void refresh();
    };
    window.addEventListener(SELECTED_HOTEL_CHANGED_EVENT, onSelected);
    return () => {
      mounted.current = false;
      window.removeEventListener(SELECTED_HOTEL_CHANGED_EVENT, onSelected);
    };
  }, [refresh]);

  // Hotels fix items in setup, often in another tab: check again when they come back (VAY-2288).
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [refresh]);

  const status = review ? bookingPageStatus(review) : null;
  const publishing = status?.kind === "publishing";

  useEffect(() => {
    if (!publishing || polls >= POLL_LIMIT) return;
    const timer = setTimeout(() => {
      setPolls((value) => value + 1);
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [publishing, polls, refresh]);

  async function publish() {
    if (active.current || !propertyId) return;
    active.current = true;
    setBusy(true);
    setPublishFailed(false);
    setPolls(0);
    let accepted = false;
    try {
      // Publish against fresh readiness evidence; the server refuses stale or repeated requests.
      const fresh = await load(propertyId);
      const current = bookingPageStatus(fresh);
      if (
        (current.kind !== "ready" && current.kind !== "failed") ||
        fresh.readiness.outcome !== "evaluated"
      )
        return;
      await bookingPublicationApi.publish({
        propertyId,
        idempotencyKey: `booking-admin:${crypto.randomUUID()}`,
        body: {
          expectedActiveContentRevisionId: fresh.activeContentRevisionId,
          expectedSourceManifestHash: fresh.readiness.sourceManifestHash,
          expectedReadinessHash: fresh.readiness.readinessHash,
        },
      });
      accepted = true;
      await load(propertyId);
    } catch {
      if (!mounted.current) return;
      if (!accepted) setPublishFailed(true);
      // A lost response may still have published; show what the server has now.
      await load(propertyId).catch(() => undefined);
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  if (noAccess || (!status && !loadFailed && !busy)) return null;
  return (
    <BookingPageStatusView
      status={
        loadFailed
          ? { kind: "unavailable" }
          : publishFailed && status?.kind === "ready"
            ? { kind: "failed", readyGroups: status.readyGroups }
            : status
      }
      propertyId={propertyId}
      busy={busy}
      stalled={publishing && polls >= POLL_LIMIT}
      onPublish={() => void publish()}
      onRefresh={() => {
        setPolls(0);
        void refresh();
      }}
    />
  );
}

export function BookingPageStatusView({
  status,
  propertyId,
  busy,
  stalled,
  onPublish,
  onRefresh,
}: {
  status: BookingPageStatus | null;
  propertyId: string | null;
  busy: boolean;
  stalled: boolean;
  onPublish: () => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const offline = t("dashboard.bookingPage.status.offline");
  const checkAgain = (
    <SecondaryButton disabled={busy} onClick={onRefresh}>
      {t("dashboard.bookingPage.checkAgain")}
    </SecondaryButton>
  );
  const publishButton = (disabled: boolean, label = t("dashboard.bookingPage.publish")) => (
    <button
      type="button"
      disabled={disabled}
      onClick={onPublish}
      className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );

  if (!status)
    return (
      <Card>
        <Summary
          tone="gray"
          icon={<Spinner />}
          detail={t("dashboard.bookingPage.loading")}
          pill={null}
        />
      </Card>
    );

  switch (status.kind) {
    case "online":
      return (
        <Card>
          <Summary
            tone={status.items.length ? "amber" : "green"}
            icon={<GlobeAltIcon className="h-5 w-5" />}
            pill={<Pill dot="bg-green-500">{t("dashboard.bookingPage.status.online")}</Pill>}
            detail={
              <>
                <a
                  href={status.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-primary-600 hover:underline"
                >
                  {status.url.replace(/^https:\/\//, "").replace(/\/$/, "")}
                </a>
                <span aria-hidden="true"> · </span>
                {status.items.length
                  ? t("dashboard.bookingPage.online.needsAttention")
                  : t("dashboard.bookingPage.online.detail")}
              </>
            }
            actions={
              <a
                href={status.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50"
              >
                {t("dashboard.bookingPage.openPage")}
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 text-gray-500" />
              </a>
            }
          />
          <MissingItems items={status.items} propertyId={propertyId} />
        </Card>
      );
    case "hidden":
      return (
        <Card>
          <Summary
            tone="amber"
            icon={<GlobeAltIcon className="h-5 w-5" />}
            pill={<Pill dot="bg-amber-500">{offline}</Pill>}
            detail={t("dashboard.bookingPage.hidden.detail")}
            actions={checkAgain}
          />
          <MissingItems items={status.items} propertyId={propertyId} />
        </Card>
      );
    case "publishing":
      return (
        <Card>
          <Summary
            tone="primary"
            icon={<Spinner />}
            pill={<Pill dot="bg-primary-500">{t("dashboard.bookingPage.status.publishing")}</Pill>}
            detail={
              stalled
                ? t("dashboard.bookingPage.publishing.stalled")
                : t("dashboard.bookingPage.publishing.detail")
            }
            actions={
              stalled
                ? checkAgain
                : publishButton(true, t("dashboard.bookingPage.status.publishing"))
            }
          />
        </Card>
      );
    case "ready":
      return (
        <Card>
          <Summary
            tone="gray"
            icon={<GlobeAltIcon className="h-5 w-5" />}
            pill={<Pill dot="bg-gray-400">{offline}</Pill>}
            detail={t("dashboard.bookingPage.ready.detail")}
            actions={publishButton(busy)}
          />
          <ReadyGroups groups={status.readyGroups} all />
        </Card>
      );
    case "failed":
      return (
        <Card>
          <Summary
            tone="red"
            icon={<ExclamationTriangleIcon className="h-5 w-5" />}
            pill={<Pill dot="bg-red-500">{t("dashboard.bookingPage.status.failed")}</Pill>}
            detail={t("dashboard.bookingPage.failed.detail")}
            actions={publishButton(busy, t("dashboard.bookingPage.tryAgain"))}
          />
          <ReadyGroups groups={status.readyGroups} all />
        </Card>
      );
    case "not_ready":
    case "waiting":
      return (
        <Card>
          <Summary
            tone="amber"
            icon={<GlobeAltIcon className="h-5 w-5" />}
            pill={<Pill dot="bg-amber-500">{offline}</Pill>}
            detail={
              status.kind === "waiting"
                ? t("dashboard.bookingPage.waiting.detail")
                : status.items.length === 1
                  ? t("dashboard.bookingPage.notReady.detailOne")
                  : t("dashboard.bookingPage.notReady.detailMany", { count: status.items.length })
            }
            actions={status.kind === "waiting" ? checkAgain : publishButton(true)}
          />
          <MissingItems items={status.items} propertyId={propertyId} />
          <ReadyGroups groups={status.readyGroups} />
        </Card>
      );
    case "unavailable":
      return (
        <Card>
          <Summary
            tone="gray"
            icon={<GlobeAltIcon className="h-5 w-5" />}
            pill={null}
            detail={t("dashboard.bookingPage.unavailable.detail")}
            actions={checkAgain}
          />
        </Card>
      );
  }
}

const TONES = {
  gray: "bg-gray-100 text-gray-500",
  green: "bg-green-50 text-green-600",
  amber: "bg-amber-50 text-amber-600",
  red: "bg-red-50 text-red-600",
  primary: "bg-primary-50 text-primary-600",
} as const;

function Card({ children }: { children: ReactNode }) {
  return (
    <section
      aria-labelledby="booking-page-status-title"
      className="overflow-hidden rounded-xl border border-gray-200 bg-white"
    >
      {children}
    </section>
  );
}

function Summary({
  tone,
  icon,
  pill,
  detail,
  actions,
}: {
  tone: keyof typeof TONES;
  icon: ReactNode;
  pill: ReactNode;
  detail: ReactNode;
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3.5">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${TONES[tone]}`}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="booking-page-status-title" className="text-sm font-semibold text-gray-900">
              {t("dashboard.bookingPage.title")}
            </h2>
            {pill}
          </div>
          <p role="status" className="mt-0.5 text-[13px] leading-5 text-gray-600">
            {detail}
          </p>
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-3">{actions}</div>}
    </div>
  );
}

function Pill({ dot, children }: { dot: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-700">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {children}
    </span>
  );
}

function SecondaryButton({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

function MissingItems({
  items,
  propertyId,
}: {
  items: BookingPageItem[];
  propertyId: string | null;
}) {
  const { t } = useTranslation();
  if (!items.length) return null;
  return (
    <ul className="divide-y divide-gray-100 border-t border-gray-100 px-5">
      {items.map((item) => (
        <li
          key={item.groupId}
          className="flex flex-col gap-1 py-3 text-[13px] leading-5 sm:flex-row sm:items-center sm:gap-3"
        >
          <span className="hidden w-10 shrink-0 justify-center sm:flex" aria-hidden="true">
            <span className="h-2 w-2 rounded-full bg-amber-500" />
          </span>
          <span className="font-semibold text-gray-900 sm:w-40 sm:shrink-0">
            {groupName(t, item.groupId)}
          </span>
          <span className="flex-1 text-gray-600">
            {item.message ?? t("dashboard.bookingPage.itemPending")}
          </span>
          {item.step && (
            <a
              href={buildSharedHotelSetupRedirectPath({
                entryProduct: "booking",
                returnProduct: "booking",
                returnTo: "/dashboard",
                propertyId,
                step: item.step,
                focus: item.focus,
              })}
              className="inline-flex shrink-0 items-center gap-1.5 font-medium text-primary-600 hover:underline sm:w-40 sm:justify-end"
            >
              {t("dashboard.bookingPage.fixInSetup")}
              <ArrowRightIcon className="h-3.5 w-3.5" />
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

function ReadyGroups({ groups, all = false }: { groups: string[]; all?: boolean }) {
  const { t } = useTranslation();
  if (!groups.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-gray-100 bg-gray-50 px-5 py-3 text-xs text-gray-600">
      <span className="font-medium text-gray-500">
        {all
          ? t("dashboard.bookingPage.allReady", { count: groups.length })
          : t("dashboard.bookingPage.readyLabel")}
      </span>
      {groups.map((groupId) => (
        <span key={groupId} className="inline-flex items-center gap-1.5">
          <CheckIcon className="h-3.5 w-3.5 text-green-600" strokeWidth={2} />
          {groupName(t, groupId)}
        </span>
      ))}
    </div>
  );
}

function isAccessError(error: unknown) {
  const status =
    error instanceof ApiErrorResponse
      ? error.status
      : error instanceof BookingPropertyLinkClientError
        ? error.statusCode
        : null;
  return status === 403 || status === 404;
}

function groupName(t: (key: string) => string, groupId: string) {
  return t(`dashboard.bookingPage.group.${groupId.replace(/^booking\./, "")}`);
}
