"use client";

import type {
  HotelSetupChecklist,
  HotelSetupChecklistAcknowledgeable,
  HotelSetupChecklistItemId,
} from "@vayada/domain-hotels";
import { createBrowserAuthHandoff, crossAppReauthenticationUrl } from "@vayada/product-onboarding";
import {
  HotelSetupChecklistCard,
  HotelSetupChecklistChip,
} from "@vayada/product-onboarding/HotelSetupChecklistCard";
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
    }>;

type Deps = {
  client: Pick<HotelSetupChecklistClient, "load" | "looksGood" | "setViewer">;
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
        const [checklist, hotelName] = await Promise.all([
          deps.client.load(propertyId),
          deps.hotelName().catch(() => ""),
        ]);
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

  return {
    state,
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
  hotel_basics: { app: "pms", path: "/settings" },
  first_room: { app: "pms", path: "/rooms" },
  guest_payment: { app: "booking_admin", path: "/settings/payments" },
  booking_published: { app: "booking_admin", path: "/dashboard" },
  photos: { app: "pms", path: "/rooms" },
  style: { app: "booking_admin", path: "/design-studio" },
  calendar: { app: "pms", path: "/settings" },
  guest_terms: { app: "booking_admin", path: "/settings/policies" },
  online_cards: { app: "booking_admin", path: "/settings/payments" },
};

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
  if (setup.state.kind === "ready" || !incompleteSetupPropertyId) return null;
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
  const { state } = setup;
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
