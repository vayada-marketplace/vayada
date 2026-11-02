"use client";

import type {
  HotelGoLiveChecklist,
  HotelGoLiveItemId,
  HotelSetupChecklist,
  HotelSetupChecklistAcknowledgeable,
  HotelSetupChecklistItemId,
} from "@vayada/domain-hotels";
import { createBrowserAuthHandoff, crossAppReauthenticationUrl } from "@vayada/product-onboarding";
import {
  HotelSetupChecklistCard,
  HotelSetupChecklistChip,
} from "@vayada/product-onboarding/HotelSetupChecklistCard";
import {
  GoLiveChecklistCard,
  type GoLiveChecklistMessages,
  GoLiveLaterCard,
  GoLiveSetupCard,
  goLiveSetupStepParam,
  SetupFinishedToast,
} from "@vayada/product-onboarding/GoLiveChecklistCard";
import type { HotelSetupChecklistClient } from "@vayada/product-onboarding/hotelSetupChecklistApi";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useTranslation } from "@/lib/i18n";
import { hotelSetupChecklistApi } from "@/services/api/hotelSetupChecklistClient";
import {
  getPmsPropertyProfile,
  resolveSelectedPmsPropertyId,
} from "@/services/api/pmsPropertyClient";
import { getAuthCsrfToken } from "@/services/auth/sessionStore";

import { pmsChecklistMessages } from "./pmsChecklistMessages";
import { pmsGoLiveMessages } from "./pmsGoLiveMessages";

const BOOKING_ADMIN_URL =
  process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || "https://admin.booking.vayada.com";

export type PmsSetupChecklistState =
  | Readonly<{ kind: "loading" }>
  /** No checklist (the API isn't mounted while HOTEL_FIRST_RUN_ENABLED is off, or it failed). */
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{
      kind: "ready";
      propertyId: string;
      hotelName: string;
      checklist: HotelSetupChecklist;
    }>
  /** VAY-2451: the four-step setup's cards (HOTEL_GO_LIVE_CHECKLIST_ENABLED). */
  | Readonly<{
      kind: "go_live";
      propertyId: string;
      hotelName: string;
      checklist: HotelGoLiveChecklist;
    }>;

type Deps = {
  client: Pick<HotelSetupChecklistClient, "load" | "looksGood" | "setViewer"> &
    Partial<Pick<HotelSetupChecklistClient, "loadGoLive" | "looksGoodGoLive" | "setGoLiveViewer">>;
  resolvePropertyId: () => Promise<string>;
  hotelName: () => Promise<string>;
};

const DEFAULT_DEPS: Deps = {
  client: hotelSetupChecklistApi,
  resolvePropertyId: () => resolveSelectedPmsPropertyId("loading the setup checklist"),
  hotelName: async () => (await getPmsPropertyProfile()).name,
};

/**
 * VAY-2247 wave 2: the setup checklist on the PMS dashboard. It shows whenever the checklist API answers;
 * the API is mounted only with the server's first run (HOTEL_FIRST_RUN_ENABLED), so until then the
 * dashboard keeps today's amber "setup incomplete" banner.
 */
export function usePmsSetupChecklist(deps: Deps = DEFAULT_DEPS) {
  const [state, setState] = useState<PmsSetupChecklistState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const propertyId = await deps.resolvePropertyId();
        // All at once: the go-live list when it's served; otherwise (switched off, failed) today's.
        const today = deps.client.load(propertyId);
        today.catch(() => undefined);
        const [goLive, hotelName] = await Promise.all([
          deps.client.loadGoLive?.(propertyId).catch(() => null) ?? null,
          deps.hotelName().catch(() => ""),
        ]);
        if (goLive) {
          if (active) setState({ kind: "go_live", propertyId, hotelName, checklist: goLive });
          return;
        }
        const checklist = await today;
        if (active) setState({ kind: "ready", propertyId, hotelName, checklist });
      } catch {
        if (active) setState({ kind: "unavailable" });
      }
    })();
    return () => {
      active = false;
    };
    // Loaded once per visit: the dependencies only change in tests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = useCallback(
    async (write: (propertyId: string) => Promise<HotelSetupChecklist>) => {
      if (state.kind !== "ready") return;
      const checklist = await write(state.propertyId);
      setState({ ...state, checklist });
    },
    [state],
  );

  /** "Review booking rules" on the go-live list: the guest terms' Looks good. */
  const reviewRules = async () => {
    if (state.kind !== "go_live" || !deps.client.looksGoodGoLive) return;
    const checklist = await deps.client.looksGoodGoLive(state.propertyId, "guest_terms");
    setState({ ...state, checklist });
  };
  /** The live card's Dismiss: it stays away (the same viewer flags as today's checklist). */
  const dismissGoLive = async () => {
    if (state.kind !== "go_live" || !deps.client.setGoLiveViewer) return;
    const checklist = await deps.client.setGoLiveViewer(state.propertyId, { dismissed: true });
    setState({ ...state, checklist });
  };

  return {
    state,
    reviewRules,
    dismissGoLive,
    looksGood: (item: HotelSetupChecklistAcknowledgeable) =>
      update((propertyId) => deps.client.looksGood(propertyId, item)),
    hide: () => update((propertyId) => deps.client.setViewer(propertyId, { hidden: true })),
    show: () => update((propertyId) => deps.client.setViewer(propertyId, { hidden: false })),
    dismiss: () => update((propertyId) => deps.client.setViewer(propertyId, { dismissed: true })),
  };
}

export type PmsSetupChecklist = ReturnType<typeof usePmsSetupChecklist>;

/** Opens a Booking Admin page for this hotel through the sign-in handoff (as the sidebar's app switch). */
async function openBookingAdmin(targetPath: string, propertyId: string) {
  const csrfToken = getAuthCsrfToken();
  if (csrfToken) {
    try {
      window.location.href = await createBrowserAuthHandoff({
        csrfToken,
        routingHints: { propertyId },
        sourceSurface: "pms-web",
        targetPath,
        targetSurface: "booking-admin",
      });
      return;
    } catch {
      // Require Booking Admin sign-in when the one-time exchange is unavailable.
    }
  }
  window.location.href = crossAppReauthenticationUrl(BOOKING_ADMIN_URL, targetPath);
}

/** Where each item opens from the PMS: its own pages here, Booking Admin's through the handoff. */
export const PMS_CHECKLIST_PAGES: Record<
  HotelSetupChecklistItemId,
  { app: "pms" | "booking_admin"; path: string }
> = {
  hotel_basics: { app: "pms", path: "/settings/property" },
  first_room: { app: "pms", path: "/rooms" },
  guest_payment: { app: "booking_admin", path: "/settings/payments" },
  booking_published: { app: "booking_admin", path: "/dashboard" },
  photos: { app: "pms", path: "/rooms" },
  style: { app: "booking_admin", path: "/design-studio" },
  calendar: { app: "pms", path: "/settings/calendar" },
  guest_terms: { app: "booking_admin", path: "/settings/policies" },
  online_cards: { app: "booking_admin", path: "/settings/payments" },
};

/** VAY-2451: where the go-live rows open from the PMS. */
export const PMS_GO_LIVE_PAGES: Record<
  Exclude<HotelGoLiveItemId, "booking_published">,
  { app: "pms" | "booking_admin"; path: string }
> = {
  property_details: { app: "pms", path: "/settings/property" },
  room_types: { app: "pms", path: "/rooms" },
  rates: { app: "pms", path: "/rooms" },
  booking_rules: { app: "booking_admin", path: "/settings/policies" },
  property_photos: { app: "booking_admin", path: "/design-studio" },
};

function useSetupFinishedToast() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.location?.href) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("setupFinished") !== "1") return;
    setShown(true);
    url.searchParams.delete("setupFinished");
    window.history.replaceState(window.history.state, "", url.toString());
  }, []);
  return { shown, dismiss: () => setShown(false) };
}

function PmsGoLiveCards({
  setup,
  state,
  navigate,
  messages,
}: {
  setup: PmsSetupChecklist;
  state: Extract<PmsSetupChecklistState, { kind: "go_live" }>;
  navigate: (path: string) => void;
  messages: GoLiveChecklistMessages;
}) {
  const toast = useSetupFinishedToast();
  const open = (page: { app: "pms" | "booking_admin"; path: string }) =>
    page.app === "pms" ? navigate(page.path) : void openBookingAdmin(page.path, state.propertyId);
  const { checklist } = state;
  // A live hotel's card goes once dismissed or hidden (also when today's checklist was).
  if (checklist.phase === "live" && (checklist.viewer.dismissed || checklist.viewer.hidden))
    return toast.shown ? (
      <SetupFinishedToast onDismiss={toast.dismiss} messages={messages} />
    ) : null;
  return (
    <>
      {toast.shown ? <SetupFinishedToast onDismiss={toast.dismiss} messages={messages} /> : null}
      {checklist.phase === "setup" ? (
        <GoLiveSetupCard
          checklist={checklist}
          hotelName={state.hotelName}
          onContinue={() => navigate(setupHref(state.propertyId))}
          onOpenStep={(step) =>
            step === "property" || step === "location"
              ? navigate(PMS_GO_LIVE_PAGES.property_details.path)
              : navigate(`${setupHref(state.propertyId)}&step=${goLiveSetupStepParam(step)}`)
          }
          messages={messages}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <GoLiveChecklistCard
            checklist={checklist}
            onOpenItem={(item) => {
              if (item === "booking_rules")
                void setup
                  .reviewRules()
                  .catch(() => undefined)
                  .finally(() => open(PMS_GO_LIVE_PAGES[item]));
              else open(PMS_GO_LIVE_PAGES[item]);
            }}
            // Booking Admin publishes the booking page.
            onPublish={() => void openBookingAdmin("/dashboard", state.propertyId)}
            onDismiss={() => void setup.dismissGoLive().catch(() => undefined)}
            messages={messages}
          />
          <div>
            <GoLiveLaterCard
              checklist={checklist}
              onConnectCards={() => void openBookingAdmin("/settings/payments", state.propertyId)}
              messages={messages}
            />
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Today's amber "setup incomplete" banner, unchanged, for as long as there is no checklist: while it loads
 * and whenever the API doesn't answer (it isn't mounted while HOTEL_FIRST_RUN_ENABLED is off).
 */
export function PmsDashboardSetupBanner({
  setup,
  incompleteSetupPropertyId,
}: {
  setup: PmsSetupChecklist;
  /** Set when setup was left unfinished. */
  incompleteSetupPropertyId: string | null;
}) {
  const { t } = useTranslation();
  if (setup.state.kind === "ready" || setup.state.kind === "go_live" || !incompleteSetupPropertyId)
    return null;
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between"
      role="status"
    >
      <p>{t("dashboard.setupIncomplete")}</p>
      <Link
        href={setupHref(incompleteSetupPropertyId)}
        className="shrink-0 font-semibold text-amber-950 underline decoration-amber-400 underline-offset-4 hover:decoration-amber-700"
      >
        {t("dashboard.resumeSetup")}
      </Link>
    </div>
  );
}

/** The checklist card, once the server answered with one. */
export function PmsDashboardSetupCard({
  setup,
  roomCount = null,
  navigate = (path: string) => window.location.assign(path),
}: {
  setup: PmsSetupChecklist;
  roomCount?: number | null;
  navigate?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const messages = useMemo(() => pmsChecklistMessages(t), [t]);
  const goLiveMessages = useMemo(() => pmsGoLiveMessages(t), [t]);
  const { state } = setup;
  if (state.kind === "go_live")
    return (
      <PmsGoLiveCards setup={setup} state={state} navigate={navigate} messages={goLiveMessages} />
    );
  if (state.kind !== "ready") return null;
  const open = (item: HotelSetupChecklistItemId) => {
    const page = PMS_CHECKLIST_PAGES[item];
    if (page.app === "pms") navigate(page.path);
    else void openBookingAdmin(page.path, state.propertyId);
  };
  return (
    <HotelSetupChecklistCard
      checklist={state.checklist}
      hotelName={state.hotelName}
      product="pms"
      roomCount={roomCount}
      onContinueSetup={() => navigate(setupHref(state.propertyId))}
      onOpen={open}
      onLooksGood={setup.looksGood}
      onHide={setup.hide}
      onDismiss={setup.dismiss}
      messages={messages}
    />
  );
}

/** The "Setup N of 9" pill while the checklist is hidden; it brings the card back. */
export function PmsDashboardSetupChip({ setup }: { setup: PmsSetupChecklist }) {
  const { t } = useTranslation();
  const messages = useMemo(() => pmsChecklistMessages(t), [t]);
  if (setup.state.kind !== "ready") return null;
  return (
    <HotelSetupChecklistChip
      checklist={setup.state.checklist}
      onShow={() => void setup.show()}
      messages={messages}
    />
  );
}

function setupHref(propertyId: string) {
  return `/setup?entryProduct=pms&returnTo=%2Fdashboard&propertyId=${encodeURIComponent(propertyId)}`;
}
