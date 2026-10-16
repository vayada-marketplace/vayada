"use client";

import { useMemo, type MutableRefObject, type ReactNode } from "react";
import { useTranslation } from "@/lib/i18n";
import { createReplacementPricingClient } from "@/services/api/replacementPricingClient";

import type { SetupRoom } from "./FirstPricingSetup";
import type { NewRoomPrices } from "./newRoomPrices";
import { PricingEditor } from "./PricingEditor";
import * as ui from "./pricingStyles";
import { PricingRoomsError } from "./PricingRoomsError";
import { usePricingRooms } from "./usePricingRooms";

/** The New room page's Prices tab (VAY-2147): prices for the room being typed, under a temporary id; the page's
 * "Create Room Type" saves them. The property's rooms are read for its currency and the room names. */
export function NewRoomPricesTab({
  room,
  facts,
  take,
  actions,
  locked,
  onPrices,
  onAttention,
}: {
  room: SetupRoom;
  facts: { size: number | null; photo: string | null };
  take: MutableRefObject<(() => NewRoomPrices | null) | null>;
  actions: ReactNode;
  locked: boolean;
  onPrices: (entered: boolean) => void;
  /** A leave confirmation is waiting in this tab: the page shows it. */
  onAttention: () => void;
}) {
  const { rooms, error, retry } = usePricingRooms();
  const { t } = useTranslation();
  const propertyId = rooms?.propertyId;
  const client = useMemo(
    () => (propertyId ? createReplacementPricingClient(propertyId) : null),
    [propertyId],
  );
  // Without the editor the page's buttons still sit in the bar: the room can be created without prices.
  if (error || !rooms || !client)
    return (
      <section className="space-y-4">
        {error ? (
          <PricingRoomsError error={error} onRetry={retry} />
        ) : (
          <p role="status" className="text-[12px] text-gray-500">
            {t("pricing.page.loading")}
          </p>
        )}
        <div className={`flex-wrap ${ui.actionBar}`}>{actions}</div>
      </section>
    );
  return (
    <PricingEditor
      key={rooms.propertyId}
      client={client}
      roomNames={{ ...rooms.names, [room.roomTypeId]: room.name }}
      roomFacts={{ [room.roomTypeId]: facts }}
      setup={{ propertyId: rooms.propertyId, rooms: [room] }}
      roomTypeId={room.roomTypeId}
      onAttention={onAttention}
      newRoom={{ take, actions, locked, onPrices }}
    />
  );
}
