"use client";

import { useMemo } from "react";
import { useTranslation } from "@/lib/i18n";
import { createReplacementPricingClient } from "@/services/api/replacementPricingClient";

import { PricingEditor } from "./PricingEditor";
import { errorText } from "./pricingAmounts";
import { usePricingRooms } from "./usePricingRooms";

/** The room page's Prices tab: this room's rates. Saving publishes them with the property's other rooms unchanged. */
export function RoomPricesTab({ roomTypeId }: { roomTypeId: string }) {
  const { rooms, error } = usePricingRooms();
  const { t } = useTranslation();
  const client = useMemo(
    () => (rooms ? createReplacementPricingClient(rooms.propertyId) : null),
    [rooms],
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
      roomTypeId={roomTypeId}
    />
  );
}
