"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { roomsService, RoomTypeCreate } from "@/services/rooms";
import { bookingsService } from "@/services/bookings";
import { importService } from "@/services/import";
import RoomTypeForm from "@/components/rooms/RoomTypeForm";

export default function NewRoomPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [initialCurrency, setInitialCurrency] = useState("EUR");
  const [sourceImageUrls, setSourceImageUrls] = useState<string[]>([]);
  const [form, setForm] = useState<RoomTypeCreate>({
    name: "",
    description: "",
    shortDescription: "",
    maxOccupancy: 2,
    maxAdults: null,
    maxChildren: null,
    size: 0,
    baseRate: 0,
    nonRefundableRate: null,
    currency: "EUR",
    address: "",
    latitude: null,
    longitude: null,
    bedType: "",
    totalRooms: 2,
    amenities: [],
    features: [],
    images: [],
    isActive: true,
    sortOrder: 0,
    monthlyRates: {},
    dailyRates: {},
  });

  // Load prefill data from listing import
  useEffect(() => {
    if (searchParams.get("from") === "import") {
      try {
        const raw = sessionStorage.getItem("importRoomType");
        if (raw) {
          const imported = JSON.parse(raw);
          const rate = imported.baseRate || 0;
          setForm((prev) => ({
            ...prev,
            name: imported.name || "",
            description: imported.description || "",
            shortDescription: imported.shortDescription || "",
            maxOccupancy: imported.maxOccupancy || 2,
            maxAdults: imported.maxAdults ?? null,
            maxChildren: imported.maxChildren ?? null,
            size: imported.size || 0,
            baseRate: rate,
            currency: imported.currency || prev.currency,
            bedType: imported.bedType || "",
            amenities: imported.amenities || [],
            features: imported.features || [],
            seasons:
              rate > 0
                ? [
                    {
                      name: "Default",
                      tier: "mid",
                      from: "01-01",
                      to: "12-31",
                      rate: String(rate),
                      minStay: 1,
                    },
                  ]
                : [],
            cancellationPolicy: imported.cancellationPolicy || prev.cancellationPolicy,
          }));
          if (imported.sourceImageUrls?.length) {
            setSourceImageUrls(imported.sourceImageUrls);
          }
          sessionStorage.removeItem("importRoomType");
        }
      } catch {}
    }
  }, [searchParams]);

  // Inherit currency from payment settings (authoritative source)
  useEffect(() => {
    bookingsService
      .getPaymentSettings()
      .then((res) => {
        const c = res.paymentSettings.defaultCurrency;
        if (c) {
          setInitialCurrency(c);
          // Only set currency if not already set by import
          setForm((prev) =>
            prev.currency && searchParams.get("from") === "import" && prev.currency !== "EUR"
              ? prev
              : { ...prev, currency: c },
          );
        }
      })
      .catch(console.error);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name) {
      setError("Name is required");
      return;
    }
    if (!form.seasons?.length || !form.seasons.some((s) => s.rate && Number(s.rate) > 0)) {
      setError("At least one season with a rate greater than 0 is required");
      return;
    }
    if (form.seasons.some((s) => s.from && s.to && (!s.rate || Number(s.rate) <= 0))) {
      setError("Every season must have a rate greater than 0");
      return;
    }
    setSaving(true);
    setError("");
    try {
      if (form.currency && form.currency !== initialCurrency) {
        await bookingsService.updatePaymentSettings({ defaultCurrency: form.currency });
      }
      const created = await roomsService.create(form);
      if (sourceImageUrls.length > 0 && created.id) {
        importService.importImages(created.id, sourceImageUrls).catch(console.error);
      }
      router.push("/rooms");
    } catch (err: any) {
      setError(err.message || "Failed to create room type");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-5xl">
      <div className="flex items-center gap-3 mb-5 md:mb-6">
        <Link href="/rooms" className="text-gray-400 hover:text-gray-600 shrink-0">
          <ArrowLeftIcon className="w-5 h-5" />
        </Link>
        <h1 className="text-xl font-bold text-gray-900 truncate">New Room Type</h1>
      </div>

      <RoomTypeForm
        form={form}
        onChange={setForm}
        onSubmit={handleSubmit}
        saving={saving}
        error={error}
        submitLabel="Create Room Type"
        cancelHref="/rooms"
        mode="create"
      />
    </div>
  );
}
