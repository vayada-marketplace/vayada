import {
  buildHotelGoLiveChecklist,
  buildHotelSetupChecklist,
  type HotelGoLiveChecklist,
  type HotelGoLiveRoomType,
  type HotelSetupChecklist,
  type HotelSetupChecklistAcknowledgeable,
  type HotelSetupChecklistDefault,
} from "@vayada/domain-hotels";

import type { HotelFirstRunSetupProgress } from "./hotelFirstRunFacts.js";
import type { HotelFirstRunActor } from "./hotelFirstRunSteps.js";

/**
 * VAY-2247 wave 2: the setup checklist both dashboards show. Setup progress comes from the first run's light
 * setup-progress read (rooms, prices, payment methods and plan, one at a time; not the booking readiness,
 * which starved the API's pools when every dashboard load ran it, 2026-10-21); the rest from what the hotel
 * has, read in one query, plus the two things the checklist remembers (migration 0503): "Looks good" per
 * hotel and each person's Hide for now / Dismiss.
 */

/** What one query tells about the hotel and the signed-in person; null when the hotel isn't there. */
export type HotelSetupChecklistFactsRow = Readonly<{
  hotelBasics: boolean;
  bookingPublished: boolean;
  photos: boolean;
  style: boolean;
  calendar: HotelSetupChecklistDefault;
  guestTerms: HotelSetupChecklistDefault;
  onlineCardReady: boolean;
  viewer: Readonly<{ hidden: boolean; dismissed: boolean }>;
}>;

/** VAY-2451: what the go-live list reads in one query, besides whether setup is finished. */
export type HotelGoLiveFactsRow = Readonly<{
  propertyDetails: boolean;
  bookingPublished: boolean;
  propertyPhotos: boolean;
  bookingRules: HotelSetupChecklistDefault;
  onlineCardReady: boolean;
  roomTypes: readonly HotelGoLiveRoomType[];
  placeholderPrices: boolean;
  viewer: Readonly<{ hidden: boolean; dismissed: boolean }>;
}>;

export type HotelSetupChecklistViewerChange = Readonly<{ hidden?: boolean; dismissed?: boolean }>;

/** v1: the current dashboards' checklist; v2: the go-live list of the four-step setup (VAY-2451). */
export type HotelSetupChecklistView = "v1" | "v2";

export type HotelSetupChecklistPorts = Readonly<{
  /** Only whether the first room and price, and how guests pay, are done: the first run's light read. */
  firstRun: { readSetupProgress(actor: HotelFirstRunActor): Promise<HotelFirstRunSetupProgress> };
  facts: { read(actor: HotelFirstRunActor): Promise<HotelSetupChecklistFactsRow | null> };
  goLiveFacts: { read(actor: HotelFirstRunActor): Promise<HotelGoLiveFactsRow | null> };
  store: {
    acknowledge(actor: HotelFirstRunActor, item: HotelSetupChecklistAcknowledgeable): Promise<void>;
    setViewer(actor: HotelFirstRunActor, change: HotelSetupChecklistViewerChange): Promise<void>;
  };
  /** Online card payments are offered to hotels (VAY-2205); until then the item says Later. */
  onlineCardsOffered: boolean;
}>;

export function createHotelSetupChecklistService(ports: HotelSetupChecklistPorts) {
  async function read(actor: HotelFirstRunActor): Promise<HotelSetupChecklist | null> {
    // One after the other, never in parallel: each dashboard load reads this (VAY-2247 incident).
    const facts = await ports.facts.read(actor);
    if (!facts) return null;
    const { firstRoom, guestPayment } = await ports.firstRun.readSetupProgress(actor);
    return buildHotelSetupChecklist({
      propertyId: actor.propertyId,
      nextSetupStep: !firstRoom ? "first_room" : !guestPayment ? "guest_payment" : "go_live",
      hotelBasics: facts.hotelBasics,
      firstRoom,
      guestPayment,
      bookingPublished: facts.bookingPublished,
      photos: facts.photos,
      style: facts.style,
      calendar: facts.calendar,
      guestTerms: facts.guestTerms,
      onlineCardReady: facts.onlineCardReady,
      onlineCardsOffered: ports.onlineCardsOffered,
      viewer: facts.viewer,
    });
  }

  /** VAY-2451: the go-live list. Setup is finished once how guests pay and the plan are saved. */
  async function readGoLive(actor: HotelFirstRunActor): Promise<HotelGoLiveChecklist | null> {
    const facts = await ports.goLiveFacts.read(actor);
    if (!facts) return null;
    const { guestPayment } = await ports.firstRun.readSetupProgress(actor);
    return buildHotelGoLiveChecklist({
      propertyId: actor.propertyId,
      setupFinished: guestPayment,
      onlineCardsOffered: ports.onlineCardsOffered,
      ...facts,
    });
  }

  const readView = (actor: HotelFirstRunActor, view: HotelSetupChecklistView) =>
    view === "v2" ? readGoLive(actor) : read(actor);

  return {
    read,
    readGoLive,
    /** "Looks good": the hotel keeps setup's default for the item; returns the checklist after it. */
    async acknowledge(
      actor: HotelFirstRunActor,
      item: HotelSetupChecklistAcknowledgeable,
      view: HotelSetupChecklistView = "v1",
    ) {
      await ports.store.acknowledge(actor, item);
      return readView(actor, view);
    },
    /** The signed-in person's Hide for now (or showing it again) and Dismiss. */
    async setViewer(
      actor: HotelFirstRunActor,
      change: HotelSetupChecklistViewerChange,
      view: HotelSetupChecklistView = "v1",
    ) {
      await ports.store.setViewer(actor, change);
      return readView(actor, view);
    },
  };
}

export type HotelSetupChecklistService = ReturnType<typeof createHotelSetupChecklistService>;
