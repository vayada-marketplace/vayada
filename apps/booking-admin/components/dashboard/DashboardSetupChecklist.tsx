"use client";

import type {
  HotelSetupChecklist,
  HotelSetupChecklistAcknowledgeable,
  HotelSetupChecklistItemId,
} from "@vayada/domain-hotels";
import {
  buildSharedHotelSetupRedirectPath,
  createBrowserAuthHandoff,
  crossAppReauthenticationUrl,
} from "@vayada/product-onboarding";
import {
  HotelSetupChecklistCard,
  HotelSetupChecklistChip,
} from "@vayada/product-onboarding/HotelSetupChecklistCard";
import type { HotelSetupChecklistClient } from "@vayada/product-onboarding/hotelSetupChecklistApi";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useTranslation } from "@/lib/i18n";
import { getBookingHotelPropertyLink } from "@/services/api/bookingPropertyLinkClient";
import {
  getSelectedBookingHotelId,
  SELECTED_HOTEL_CHANGED_EVENT,
} from "@/services/api/bookingHotelScope";
import { hotelSetupChecklistApi } from "@/services/api/hotelSetupChecklistClient";
import { getAuthCsrfToken } from "@/services/auth/sessionStore";

import { bookingAdminChecklistMessages } from "./bookingAdminChecklistMessages";

const PMS_FRONTEND_URL = process.env.NEXT_PUBLIC_PMS_FRONTEND_URL || "https://pms.vayada.com";

export type DashboardSetupChecklistState =
  | Readonly<{ kind: "loading" }>
  /** No checklist (the API isn't mounted while HOTEL_FIRST_RUN_ENABLED is off, or it failed). */
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "ready"; propertyId: string; checklist: HotelSetupChecklist }>;

type Deps = {
  client: Pick<HotelSetupChecklistClient, "load" | "looksGood" | "setViewer">;
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
 * VAY-2247 wave 2: the setup checklist on the Booking Admin dashboard. It shows whenever the checklist
 * API answers; the API is mounted only with the server's first run (HOTEL_FIRST_RUN_ENABLED), so until
 * then the dashboard stays as it is today.
 */
export function useDashboardSetupChecklist(deps: Deps = DEFAULT_DEPS) {
  const [state, setState] = useState<DashboardSetupChecklistState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    let started = false;
    const load = async () => {
      if (started) return;
      try {
        const propertyId = await deps.resolvePropertyId();
        // With several hotels the header may store the selection after the dashboard mounted.
        if (!propertyId || started || !active) return;
        started = true;
        const checklist = await deps.client.load(propertyId);
        if (active) setState({ kind: "ready", propertyId, checklist });
      } catch {
        started = true;
        if (active) setState({ kind: "unavailable" });
      }
    };
    void load();
    const onSelected = () => void load();
    window.addEventListener(SELECTED_HOTEL_CHANGED_EVENT, onSelected);
    return () => {
      active = false;
      window.removeEventListener(SELECTED_HOTEL_CHANGED_EVENT, onSelected);
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

  return {
    state,
    looksGood: (item: HotelSetupChecklistAcknowledgeable) =>
      update((propertyId) => deps.client.looksGood(propertyId, item)),
    hide: () => update((propertyId) => deps.client.setViewer(propertyId, { hidden: true })),
    show: () => update((propertyId) => deps.client.setViewer(propertyId, { hidden: false })),
    dismiss: () => update((propertyId) => deps.client.setViewer(propertyId, { dismissed: true })),
  };
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

/** Where each item opens from Booking Admin: its own pages here, the PMS's through the handoff. */
export const BOOKING_ADMIN_CHECKLIST_PAGES: Record<
  HotelSetupChecklistItemId,
  { app: "pms" | "booking_admin"; path: string }
> = {
  hotel_basics: { app: "booking_admin", path: "/settings/general" },
  first_room: { app: "pms", path: "/rooms" },
  guest_payment: { app: "booking_admin", path: "/settings/payments" },
  booking_published: { app: "booking_admin", path: "/dashboard" },
  photos: { app: "pms", path: "/rooms" },
  style: { app: "booking_admin", path: "/design-studio" },
  calendar: { app: "pms", path: "/settings" },
  guest_terms: { app: "booking_admin", path: "/settings/policies" },
  online_cards: { app: "booking_admin", path: "/settings/payments" },
};

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
  const messages = useMemo(() => bookingAdminChecklistMessages(t), [t]);
  const { state } = setup;
  if (state.kind !== "ready") return null;
  const open = (item: HotelSetupChecklistItemId) => {
    const page = BOOKING_ADMIN_CHECKLIST_PAGES[item];
    if (page.app === "booking_admin") navigate(page.path);
    else void openPms(page.path, state.propertyId);
  };
  return (
    <HotelSetupChecklistCard
      checklist={state.checklist}
      hotelName={hotelName}
      product="booking_admin"
      onContinueSetup={() =>
        navigate(
          buildSharedHotelSetupRedirectPath({
            entryProduct: "booking",
            returnProduct: "booking",
            returnTo: "/dashboard",
            propertyId: state.propertyId,
          }),
        )
      }
      onOpen={open}
      onLooksGood={setup.looksGood}
      onHide={setup.hide}
      onDismiss={setup.dismiss}
      messages={messages}
    />
  );
}

/** The "Setup N of 9" pill while the checklist is hidden; it brings the card back. */
export function DashboardSetupChecklistChip({ setup }: { setup: DashboardSetupChecklist }) {
  const { t } = useTranslation();
  const messages = useMemo(() => bookingAdminChecklistMessages(t), [t]);
  if (setup.state.kind !== "ready") return null;
  return (
    <HotelSetupChecklistChip
      checklist={setup.state.checklist}
      onShow={() => void setup.show()}
      messages={messages}
    />
  );
}
