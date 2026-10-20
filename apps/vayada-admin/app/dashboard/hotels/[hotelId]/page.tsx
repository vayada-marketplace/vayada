"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import { bookingSettingsService, type SuperAdminHotel } from "@/services/booking";
import DesignStudioSection from "@/components/booking/DesignStudioSection";
import BookingFlowSection from "@/components/booking/BookingFlowSection";
import HotelSettingsSection from "@/components/booking/HotelSettingsSection";
import CardPaymentsSection from "@/components/booking/CardPaymentsSection";
import BookingAddressSection from "@/components/booking/BookingAddressSection";

type Section = "design" | "booking" | "settings" | "payments" | "address";

export default function HotelConfigPage() {
  const params = useParams();
  const router = useRouter();
  const hotelId = params.hotelId as string;

  const [activeSection, setActiveSection] = useState<Section>("design");
  const [hotel, setHotel] = useState<SuperAdminHotel | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    bookingSettingsService
      .listAllHotels()
      .then((hotels) => {
        const found = hotels.find((h) => h.id === hotelId);
        if (found) setHotel(found);
        // The list holds every property, test data included: a hotel missing from it doesn't
        // exist, as with a mistyped or pasted link (VAY-2295).
        else setMissing(true);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [hotelId]);

  const sections = [
    { id: "design" as const, label: "Design Studio" },
    { id: "booking" as const, label: "Booking Flow" },
    { id: "settings" as const, label: "Settings" },
    // VAY-2205: card payments for Vayada finance.
    { id: "payments" as const, label: "Payments" },
    // VAY-2295: the booking page address, changed by a Vayada operator.
    { id: "address" as const, label: "Address" },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push("/dashboard/hotels")}
              className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100 transition-colors"
            >
              <ArrowLeftIcon className="w-5 h-5" />
            </button>
            <div className="flex-1">
              {/* Breadcrumb */}
              <div className="flex items-center gap-1.5 text-sm text-gray-500">
                <button onClick={() => router.push("/dashboard")} className="hover:text-gray-700">
                  Dashboard
                </button>
                <span>/</span>
                <button
                  onClick={() => router.push("/dashboard/hotels")}
                  className="hover:text-gray-700"
                >
                  Hotels
                </button>
                <span>/</span>
                <span className="text-gray-900 font-medium">
                  {loading
                    ? "..."
                    : missing
                      ? "Hotel not found"
                      : hotel?.name || "Hotel Configuration"}
                </span>
              </div>
              <h1 className="text-xl font-bold text-gray-900 mt-0.5">
                {loading
                  ? "Loading..."
                  : missing
                    ? "Hotel not found"
                    : hotel?.name || "Hotel Configuration"}
              </h1>
            </div>
          </div>

          {/* Section tabs */}
          <div className="mt-4 flex gap-1">
            {(missing ? [] : sections).map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  activeSection === section.id
                    ? "bg-primary-50 text-primary-700 border border-primary-200"
                    : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
                }`}
              >
                {section.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Content */}
      {missing ? (
        <div className="px-4 sm:px-6 lg:px-8 py-6">
          <div className="max-w-3xl rounded-lg border border-gray-200 bg-white p-5 text-sm text-gray-600">
            <p>
              There&apos;s no hotel at this link. Check the link, or open the hotel from the list.
            </p>
            <button
              type="button"
              onClick={() => router.push("/dashboard/hotels")}
              className="mt-4 rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
            >
              Back to Hotels
            </button>
          </div>
        </div>
      ) : (
        <div className="px-4 sm:px-6 lg:px-8 py-6" style={{ height: "calc(100vh - 160px)" }}>
          {activeSection === "design" && <DesignStudioSection hotelId={hotelId} />}
          {activeSection === "booking" && <BookingFlowSection hotelId={hotelId} />}
          {activeSection === "settings" && <HotelSettingsSection hotelId={hotelId} />}
          {activeSection === "payments" && (
            <CardPaymentsSection hotelId={hotelId} hotelName={hotel?.name ?? "this hotel"} />
          )}
          {activeSection === "address" && (
            <BookingAddressSection hotelId={hotelId} currentSlug={hotel?.slug} />
          )}
        </div>
      )}
    </div>
  );
}
