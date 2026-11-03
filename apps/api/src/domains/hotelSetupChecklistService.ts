import {
  buildHotelGoLiveChecklist,
  type HotelGoLiveChecklist,
  type HotelGoLiveRoomType,
  type HotelSetupChecklistAcknowledgeable,
  type HotelSetupChecklistDefault,
} from "@vayada/domain-hotels";

import type { HotelFirstRunSetupProgress } from "./hotelFirstRunFacts.js";
import type { HotelFirstRunActor } from "./hotelFirstRunSteps.js";

/**
 * VAY-2247 wave 2, VAY-2451: the go-live list both dashboards show. Whether setup is finished comes from the
 * first run's light setup-progress read (payment methods and plan, one at a time; not the booking readiness,
 * which starved the API's pools when every dashboard load ran it, 2026-10-21); the rest from what the hotel
 * has, read in one query, plus the two things the list remembers (migration 0503): "Looks good" per hotel
 * and each person's Hide for now / Dismiss.
 */

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

export type HotelSetupChecklistPorts = Readonly<{
  /** Only whether how guests pay and the plan are saved: the first run's light read. */
  firstRun: { readSetupProgress(actor: HotelFirstRunActor): Promise<HotelFirstRunSetupProgress> };
  goLiveFacts: { read(actor: HotelFirstRunActor): Promise<HotelGoLiveFactsRow | null> };
  store: {
    acknowledge(actor: HotelFirstRunActor, item: HotelSetupChecklistAcknowledgeable): Promise<void>;
    setViewer(actor: HotelFirstRunActor, change: HotelSetupChecklistViewerChange): Promise<void>;
  };
  /** Online card payments are offered to hotels (VAY-2205); until then the item says Later. */
  onlineCardsOffered: boolean;
}>;

export function createHotelSetupChecklistService(ports: HotelSetupChecklistPorts) {
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

  return {
    readGoLive,
    /** "Looks good": the hotel keeps setup's default for the item; returns the list after it. */
    async acknowledge(actor: HotelFirstRunActor, item: HotelSetupChecklistAcknowledgeable) {
      await ports.store.acknowledge(actor, item);
      return readGoLive(actor);
    },
    /** The signed-in person's Hide for now and Dismiss. */
    async setViewer(actor: HotelFirstRunActor, change: HotelSetupChecklistViewerChange) {
      await ports.store.setViewer(actor, change);
      return readGoLive(actor);
    },
  };
}

export type HotelSetupChecklistService = ReturnType<typeof createHotelSetupChecklistService>;
