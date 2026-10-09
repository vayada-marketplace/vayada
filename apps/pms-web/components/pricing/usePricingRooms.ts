"use client";

import { useEffect, useState } from "react";
import { resolveSelectedPmsPropertyId } from "@/services/api/pmsPropertyClient";
import { pmsOperationsRoomsReadService, type PmsOperationsRoomType } from "@/services/rooms";

import type { SetupRoom } from "./FirstPricingSetup";
import { PricingError } from "./pricingAmounts";

export type PricingRooms = {
  propertyId: string;
  names: Record<string, string>;
  setupRooms: SetupRoom[];
};

/** Rooms that can be priced: active, with whole-number guest limits and no more adults than the total. */
export function pricingSetupRooms(items: readonly PmsOperationsRoomType[]): SetupRoom[] {
  return items
    .filter(
      (room) =>
        room.active &&
        ["total", "adults", "children"].every(
          (key) =>
            Number.isSafeInteger(room.occupancyLimits[key]) &&
            room.occupancyLimits[key] >= (key === "children" ? 0 : 1),
        ) &&
        room.occupancyLimits.adults <= room.occupancyLimits.total,
    )
    .map((room) => ({
      roomTypeId: room.roomTypeId,
      name: room.name,
      capacity: {
        total: room.occupancyLimits.total,
        adults: room.occupancyLimits.adults,
        children: room.occupancyLimits.children,
      },
    }));
}

/** The selected property's rooms for pricing: a name for every room and the rooms that can be priced. */
export function usePricingRooms() {
  const [rooms, setRooms] = useState<PricingRooms | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    void resolveSelectedPmsPropertyId("loading pricing")
      .then(async (id) => {
        const listed = await pmsOperationsRoomsReadService.listRoomTypes(id);
        if (listed.propertyId !== id) throw new PricingError("pricing.page.roomMismatch");
        if (active)
          setRooms({
            propertyId: id,
            names: Object.fromEntries(listed.items.map((room) => [room.roomTypeId, room.name])),
            setupRooms: pricingSetupRooms(listed.items),
          });
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e : new PricingError("pricing.page.loadFailed"));
      });
    return () => {
      active = false;
    };
  }, []);
  return { rooms, error };
}
