"use client";
import { useRef, useState } from "react";
import { sharedSetupClient } from "@/services/api/sharedHotelSetupClient";

export function AirbnbImportStart({ propertyId }: { propertyId: string }) {
  const busy = useRef(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function connect() {
    if (busy.current) return;
    busy.current = true;
    setConnecting(true);
    setError(null);
    try {
      const result = await sharedSetupClient.post<{ url: string; sourceId: string }>(
        `/api/hotel-setup/properties/${propertyId}/airbnb-import/start`,
        {},
      );
      const url = new URL(result.url);
      if (
        url.protocol !== "https:" ||
        !["airbnb.com", "www.airbnb.com"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port ||
        url.hash
      )
        throw new Error("Invalid connection destination");
      window.location.assign(url.href);
    } catch (cause) {
      const status =
        typeof cause === "object" && cause !== null && "status" in cause ? cause.status : undefined;
      setError(
        status === 409
          ? "Airbnb import is not ready for this hotel yet. You can continue setting up rooms manually."
          : "We couldn’t start the Airbnb connection. Please try again or continue setting up rooms manually.",
      );
      busy.current = false;
      setConnecting(false);
    }
  }
  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <h1 className="text-2xl font-semibold text-gray-950">Connect Airbnb</h1>
      <p className="mt-3 text-gray-600">
        Sign in to Airbnb and approve access. You’ll return here to choose listings, review their
        details, and fill in anything missing before saving rooms.
      </p>
      <p className="mt-3 text-sm text-gray-600">
        Your hotel setup stays open in the original tab. Refresh it after importing to see your
        saved rooms.
      </p>
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={connecting}
        onClick={() => void connect()}
        className="mt-6 rounded-lg bg-primary-600 px-5 py-3 font-semibold text-white disabled:opacity-50"
      >
        {connecting ? "Connecting…" : "Continue to Airbnb"}
      </button>
      <a
        className="mt-5 block text-sm underline"
        href={`/setup?propertyId=${encodeURIComponent(propertyId)}`}
      >
        Continue setup manually
      </a>
    </main>
  );
}
