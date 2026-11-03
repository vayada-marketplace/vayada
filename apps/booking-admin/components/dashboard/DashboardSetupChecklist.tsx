"use client";

import type {
  HotelGoLiveChecklist,
  HotelGoLiveItemId,
  HotelGoLiveSetupStep,
} from "@vayada/domain-hotels";
import {
  buildSharedHotelSetupRedirectPath,
  createBrowserAuthHandoff,
  crossAppReauthenticationUrl,
} from "@vayada/product-onboarding";
import {
  GoLiveChecklistCard,
  type GoLiveChecklistMessages,
  GoLiveLaterCard,
  GoLiveSetupCard,
  goLiveSetupStepParam,
  SetupFinishedToast,
} from "@vayada/product-onboarding/GoLiveChecklistCard";
import type { HotelSetupChecklistClient } from "@vayada/product-onboarding/hotelSetupChecklistApi";
import { useEffect, useMemo, useState } from "react";

import { useTranslation } from "@/lib/i18n";
import { getBookingHotelPropertyLink } from "@/services/api/bookingPropertyLinkClient";
import {
  getSelectedBookingHotelId,
  SELECTED_HOTEL_CHANGED_EVENT,
} from "@/services/api/bookingHotelScope";
import { hotelSetupChecklistApi } from "@/services/api/hotelSetupChecklistClient";
import { getAuthCsrfToken } from "@/services/auth/sessionStore";

import { bookingAdminGoLiveMessages } from "./bookingAdminGoLiveMessages";

const PMS_FRONTEND_URL = process.env.NEXT_PUBLIC_PMS_FRONTEND_URL || "https://pms.vayada.com";

export type DashboardSetupChecklistState =
  | Readonly<{ kind: "loading" }>
  /** No checklist (the API isn't mounted while HOTEL_FIRST_RUN_ENABLED is off, or it failed). */
  | Readonly<{ kind: "unavailable" }>
  /** VAY-2451: the four-step setup's cards. */
  | Readonly<{ kind: "go_live"; propertyId: string; checklist: HotelGoLiveChecklist }>;

type Deps = {
  client: Pick<HotelSetupChecklistClient, "loadGoLive" | "looksGoodGoLive" | "setGoLiveViewer">;
  /** The selected hotel's property, or null while the header hasn't stored a selection yet. */
  resolvePropertyId: () => Promise<string | null>;
};

const DEFAULT_DEPS: Deps = {
  client: hotelSetupChecklistApi,
  resolvePropertyId: async () => {
    const hotelId = getSelectedBookingHotelId();
    return hotelId ? (await getBookingHotelPropertyLink({ hotelId })).propertyId : null;
  },
};

/**
 * VAY-2247 wave 2, VAY-2451: the four-step setup's cards on the Booking Admin dashboard. They show whenever
 * the go-live checklist answers; the API is mounted only with the server's first run
 * (HOTEL_FIRST_RUN_ENABLED), so until then the dashboard stays as it is today.
 */
export function useDashboardSetupChecklist(deps: Deps = DEFAULT_DEPS) {
  const [state, setState] = useState<DashboardSetupChecklistState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    let started = false;
    let loadedPropertyId: string | null = null;
    const load = async () => {
      if (started) return;
      try {
        const propertyId = await deps.resolvePropertyId();
        // With several hotels the header may store the selection after the dashboard mounted.
        if (!propertyId || started || !active) return;
        started = true;
        loadedPropertyId = propertyId;
        const checklist = await deps.client.loadGoLive(propertyId);
        if (active)
          setState(
            checklist ? { kind: "go_live", propertyId, checklist } : { kind: "unavailable" },
          );
      } catch {
        started = true;
        if (active) setState({ kind: "unavailable" });
      }
    };
    void load();
    const onSelected = () => void load();
    // The booking page card saw the page go online (its Publish, the list's, or a check): read the list
    // again, so it says the page is live instead of "Get ready to go live".
    const onOnline = () => {
      const propertyId = loadedPropertyId;
      if (!propertyId) return;
      void deps.client
        .loadGoLive(propertyId)
        .then((checklist) => {
          if (active && checklist) setState({ kind: "go_live", propertyId, checklist });
        })
        .catch(() => undefined);
    };
    window.addEventListener(SELECTED_HOTEL_CHANGED_EVENT, onSelected);
    window.addEventListener(BOOKING_PAGE_ONLINE_EVENT, onOnline);
    return () => {
      active = false;
      window.removeEventListener(SELECTED_HOTEL_CHANGED_EVENT, onSelected);
      window.removeEventListener(BOOKING_PAGE_ONLINE_EVENT, onOnline);
    };
    // Loaded once per visit, and again once the page goes online: the dependencies only change in tests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** "Review booking rules" on the go-live list: the guest terms' Looks good. */
  const reviewRules = async () => {
    if (state.kind !== "go_live") return;
    const checklist = await deps.client.looksGoodGoLive(state.propertyId, "guest_terms");
    setState({ ...state, checklist });
  };
  /** The live card's Dismiss: it stays away (the same viewer flags as the first checklist's). */
  const dismissGoLive = async () => {
    if (state.kind !== "go_live") return;
    const checklist = await deps.client.setGoLiveViewer(state.propertyId, { dismissed: true });
    setState({ ...state, checklist });
  };

  return { state, reviewRules, dismissGoLive };
}

export type DashboardSetupChecklist = ReturnType<typeof useDashboardSetupChecklist>;

/** Opens a PMS page for this hotel through the sign-in handoff (as the sidebar's app switch). */
async function openPms(targetPath: string, propertyId: string) {
  const csrfToken = getAuthCsrfToken();
  if (csrfToken) {
    try {
      window.location.href = await createBrowserAuthHandoff({
        csrfToken,
        routingHints: { propertyId },
        sourceSurface: "booking-admin",
        targetPath,
        targetSurface: "pms-web",
      });
      return;
    } catch {
      // Require PMS sign-in when the one-time exchange is unavailable.
    }
  }
  window.location.href = crossAppReauthenticationUrl(PMS_FRONTEND_URL, targetPath);
}

/** VAY-2451: where the go-live rows and done setup steps open from Booking Admin. */
export const BOOKING_ADMIN_GO_LIVE_PAGES: Record<
  Exclude<HotelGoLiveItemId, "booking_published">,
  { app: "pms" | "booking_admin"; path: string }
> = {
  property_details: { app: "booking_admin", path: "/settings/general" },
  room_types: { app: "pms", path: "/rooms" },
  rates: { app: "pms", path: "/rooms" },
  booking_rules: { app: "booking_admin", path: "/settings/policies" },
  property_photos: { app: "booking_admin", path: "/design-studio" },
};

/** The booking page card publishes; the go-live list's Publish asks it to (one publish path). */
export const PUBLISH_BOOKING_PAGE_EVENT = "vayada:publish-booking-page";
/** The booking page card says the page went online while the dashboard was open; the list reads again. */
export const BOOKING_PAGE_ONLINE_EVENT = "vayada:booking-page-online";

/** "Setup complete…" once, when Finish setup sent the owner here (?setupFinished=1). */
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

function GoLiveCards({
  setup,
  state,
  hotelName,
  navigate,
  messages,
}: {
  setup: DashboardSetupChecklist;
  state: Extract<DashboardSetupChecklistState, { kind: "go_live" }>;
  hotelName: string;
  navigate: (path: string) => void;
  messages: GoLiveChecklistMessages;
}) {
  const toast = useSetupFinishedToast();
  const open = (page: { app: "pms" | "booking_admin"; path: string }) =>
    page.app === "booking_admin" ? navigate(page.path) : void openPms(page.path, state.propertyId);
  const setupPath = (step?: HotelGoLiveSetupStep) =>
    `${buildSharedHotelSetupRedirectPath({
      entryProduct: "booking",
      returnProduct: "booking",
      returnTo: "/dashboard",
      propertyId: state.propertyId,
    })}${step ? `&step=${goLiveSetupStepParam(step)}` : ""}`;
  const { checklist } = state;
  // A live hotel's card goes once dismissed or hidden (also when the first checklist was).
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
          hotelName={hotelName}
          onContinue={() => navigate(setupPath())}
          onOpenStep={(step) =>
            step === "property" || step === "location"
              ? navigate(BOOKING_ADMIN_GO_LIVE_PAGES.property_details.path)
              : navigate(setupPath(step))
          }
          messages={messages}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <GoLiveChecklistCard
            checklist={checklist}
            onOpenItem={(item) => {
              // Reviewing the rules counts as "Looks good"; the policies page opens after it saved.
              if (item === "booking_rules")
                void setup
                  .reviewRules()
                  .catch(() => undefined)
                  .finally(() => open(BOOKING_ADMIN_GO_LIVE_PAGES[item]));
              else open(BOOKING_ADMIN_GO_LIVE_PAGES[item]);
            }}
            onPublish={() => window.dispatchEvent(new Event(PUBLISH_BOOKING_PAGE_EVENT))}
            onDismiss={() => void setup.dismissGoLive().catch(() => undefined)}
            messages={messages}
          />
          <div>
            <GoLiveLaterCard
              checklist={checklist}
              onConnectCards={() => navigate("/settings/payments")}
              messages={messages}
            />
          </div>
        </div>
      )}
    </>
  );
}

/** The checklist card, once the server answered with one. */
export function DashboardSetupChecklistCard({
  setup,
  hotelName,
  navigate = (path: string) => window.location.assign(path),
}: {
  setup: DashboardSetupChecklist;
  hotelName: string;
  navigate?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const goLiveMessages = useMemo(() => bookingAdminGoLiveMessages(t), [t]);
  const { state } = setup;
  if (state.kind === "go_live")
    return (
      <GoLiveCards
        setup={setup}
        state={state}
        hotelName={hotelName}
        navigate={navigate}
        messages={goLiveMessages}
      />
    );
  return null;
}
