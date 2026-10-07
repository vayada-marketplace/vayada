"use client";

import { useEffect, useMemo, useState } from "react";
import type { SetupRoom } from "@/components/pricing/FirstPricingSetup";
import { PricingEditor } from "@/components/pricing/PricingEditor";
import { errorText, PricingError } from "@/components/pricing/pricingAmounts";
import { useTranslation } from "@/lib/i18n";
import { resolveSelectedPmsPropertyId } from "@/services/api/pmsPropertyClient";
import { createReplacementPricingClient } from "@/services/api/replacementPricingClient";
import { pmsOperationsRoomsReadService } from "@/services/rooms";

export default function PricingPage() {
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [setupRooms, setSetupRooms] = useState<SetupRoom[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const { t } = useTranslation();
  useEffect(() => {
    let active = true;
    void resolveSelectedPmsPropertyId("loading pricing").then(async (id) => {
      const rooms = await pmsOperationsRoomsReadService.listRoomTypes(id);
      if (rooms.propertyId !== id) throw new PricingError("pricing.page.roomMismatch");
      if (active) {
        setSetupRooms(rooms.items.filter((room) => room.active && ["total", "adults", "children"].every((key) => Number.isSafeInteger(room.occupancyLimits[key]) && room.occupancyLimits[key] >= (key === "children" ? 0 : 1)) && room.occupancyLimits.adults <= room.occupancyLimits.total)
          .map((room) => ({ roomTypeId: room.roomTypeId, name: room.name, capacity: { total: room.occupancyLimits.total, adults: room.occupancyLimits.adults, children: room.occupancyLimits.children } })));
        setNames(Object.fromEntries(rooms.items.map((room) => [room.roomTypeId, room.name]))); setPropertyId(id); }
    }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e : new PricingError("pricing.page.loadFailed")); });
    return () => { active = false; };
  }, []);
  const client = useMemo(() => propertyId ? createReplacementPricingClient(propertyId) : null, [propertyId]);
  if (error) return <p role="alert" className="p-8 text-red-700">{errorText(error, t, "pricing.page.loadFailed")}</p>;
  if (!client) return <p role="status" className="p-8">{t("pricing.page.loading")}</p>;
  return <PricingEditor key={propertyId} client={client} roomNames={names} setup={{ propertyId: propertyId!, rooms: setupRooms }} />;
}
