"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import { createReplacementPricingClient } from "@/services/api/replacementPricingClient";

import { forgetKeptNewRoomPrices, readKeptNewRoomPrices } from "./keptNewRoomPrices";
import { PricingEditor } from "./PricingEditor";
import { PricingRoomsError } from "./PricingRoomsError";
import { usePricingRooms } from "./usePricingRooms";

/** The room page's Prices tab: this room's rates. Saving publishes them with the property's other rooms unchanged.
 * A new `refresh` (room details saved, prices republished) re-reads the rooms and, without unsaved work, the prices.
 * `staleShown`: the page shows the "Prices need to be saved again" banner, so the tab does not repeat it. */
export function RoomPricesTab({
  roomTypeId,
  refresh = 0,
  staleShown = false,
  onAttention,
  onPublished,
}: {
  roomTypeId: string;
  refresh?: number;
  staleShown?: boolean;
  onAttention?: () => void;
  onPublished?: () => void;
}) {
  const { rooms, error, retry } = usePricingRooms(refresh);
  const { t } = useTranslation();
  // Prices the New room page created this room with but could not save (VAY-2147). They stay stored, for a reload or
  // a failed read, until they are saved here or no longer apply.
  const [kept] = useState(() => readKeptNewRoomPrices(roomTypeId));
  const forget = () => forgetKeptNewRoomPrices(roomTypeId);
  const propertyId = rooms?.propertyId;
  // One client per property: re-read rooms must not reload the editor and drop unsaved prices.
  const client = useMemo(
    () => (propertyId ? createReplacementPricingClient(propertyId) : null),
    [propertyId],
  );
  if (error) return <PricingRoomsError error={error} onRetry={retry} />;
  if (!rooms || !client)
    return (
      <p role="status" className="text-[12px] text-gray-500">
        {t("pricing.page.loading")}
      </p>
    );
  return (
    <PricingEditor
      key={rooms.propertyId}
      client={client}
      roomNames={rooms.names}
      roomFacts={rooms.facts}
      setup={{ propertyId: rooms.propertyId, rooms: rooms.setupRooms }}
      // Room-type IDs are lower-case UUIDs; a URL may carry another case.
      roomTypeId={roomTypeId.toLowerCase()}
      refresh={refresh}
      staleShown={staleShown}
      onAttention={onAttention}
      onPublished={() => {
        forget();
        onPublished?.();
      }}
      kept={kept?.room.propertyId === rooms.propertyId ? kept : undefined}
      onHandover={(applied) => {
        if (!applied) forget();
      }}
    />
  );
}
