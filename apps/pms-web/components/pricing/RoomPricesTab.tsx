"use client";

import { useMemo } from "react";
import { useTranslation } from "@/lib/i18n";
import { createReplacementPricingClient } from "@/services/api/replacementPricingClient";

import { PricingEditor } from "./PricingEditor";
import { errorText } from "./pricingAmounts";
import { usePricingRooms } from "./usePricingRooms";

/** The room page's Prices tab: this room's rates. Saving publishes them with the property's other rooms unchanged.
 * A new `refresh` (room details saved, prices republished) re-reads the rooms and, without unsaved work, the prices. */
export function RoomPricesTab({
  roomTypeId,
  refresh = 0,
  onAttention,
  onPublished,
}: {
  roomTypeId: string;
  refresh?: number;
  onAttention?: () => void;
  onPublished?: () => void;
}) {
  const { rooms, error } = usePricingRooms(refresh);
  const { t } = useTranslation();
  const propertyId = rooms?.propertyId;
  // One client per property: re-read rooms must not reload the editor and drop unsaved prices.
  const client = useMemo(
    () => (propertyId ? createReplacementPricingClient(propertyId) : null),
    [propertyId],
  );
  if (error)
    return (
      <p role="alert" className="text-sm text-red-700">
        {errorText(error, t, "pricing.page.loadFailed")}
      </p>
    );
  if (!rooms || !client)
    return (
      <p role="status" className="text-sm text-gray-600">
        {t("pricing.page.loading")}
      </p>
    );
  return (
    <PricingEditor
      key={rooms.propertyId}
      client={client}
      roomNames={rooms.names}
      setup={{ propertyId: rooms.propertyId, rooms: rooms.setupRooms }}
      // Room-type IDs are lower-case UUIDs; a URL may carry another case.
      roomTypeId={roomTypeId.toLowerCase()}
      refresh={refresh}
      onAttention={onAttention}
      onPublished={onPublished}
    />
  );
}
