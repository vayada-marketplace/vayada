"use client";

import { useEffect, useMemo, useState } from "react";
import type { SetupRoom } from "@/components/pricing/FirstPricingSetup";
import { PricingEditor } from "@/components/pricing/PricingEditor";
import { resolveSelectedPmsPropertyId } from "@/services/api/pmsPropertyClient";
import { createReplacementPricingClient } from "@/services/api/replacementPricingClient";
import { pmsOperationsRoomsReadService } from "@/services/rooms";

export default function PricingPage() {
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [setupRooms, setSetupRooms] = useState<SetupRoom[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void resolveSelectedPmsPropertyId("loading pricing").then(async (id) => {
      const rooms = await pmsOperationsRoomsReadService.listRoomTypes(id);
      if (rooms.propertyId !== id) throw new Error("Room information does not match the selected property.");
      if (active) {
        setSetupRooms(rooms.items.filter((room) => room.active && ["total", "adults", "children"].every((key) => Number.isSafeInteger(room.occupancyLimits[key]) && room.occupancyLimits[key] >= (key === "children" ? 0 : 1)) && room.occupancyLimits.adults <= room.occupancyLimits.total)
          .map((room) => ({ roomTypeId: room.roomTypeId, name: room.name, capacity: { total: room.occupancyLimits.total, adults: room.occupancyLimits.adults, children: room.occupancyLimits.children } })));
        setNames(Object.fromEntries(rooms.items.map((room) => [room.roomTypeId, room.name]))); setPropertyId(id); }
    }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "Could not load the selected property."); });
    return () => { active = false; };
  }, []);
  const client = useMemo(() => propertyId ? createReplacementPricingClient(propertyId) : null, [propertyId]);
  if (error) return <p role="alert" className="p-8 text-red-700">{error}</p>;
  if (!client) return <p role="status" className="p-8">Loading selected property…</p>;
  return <PricingEditor key={propertyId} client={client} roomNames={names} setup={{ propertyId: propertyId!, rooms: setupRooms }} />;
}
