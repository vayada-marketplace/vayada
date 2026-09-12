"use client";
import { useEffect, useRef, useState } from "react";
import { sharedSetupClient } from "@/services/api/sharedHotelSetupClient";

import { prepareAirbnbHotel, AirbnbPreparationError } from "./prepareAirbnbHotel";

export function AirbnbImportStart({ propertyId }: { propertyId: string }) {
  const busy = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [preparing, setPreparing] = useState(false);
  useEffect(() => () => controller.current?.abort(), []);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function connect() {
    if (busy.current) return;
    busy.current = true;
    setConnecting(true);
    setError(null);
    controller.current = new AbortController();
    const signal = controller.current.signal;
    try {
      const start = () =>
        sharedSetupClient.post<{ url: string; sourceId: string }>(
          `/api/hotel-setup/properties/${propertyId}/airbnb-import/start`,
          {},
          { signal },
        );
      let result;
      try {
        result = await start();
      } catch (cause) {
        if (
          !(
            cause &&
            typeof cause === "object" &&
            "status" in cause &&
            cause.status === 409 &&
            "data" in cause &&
            (cause.data as { code?: string })?.code === "channex_binding_required"
          )
        )
          throw cause;
        setPreparing(true);
        const key = `airbnb-prepare:${propertyId}`;
        const commandId = sessionStorage.getItem(key) ?? crypto.randomUUID();
        sessionStorage.setItem(key, commandId);
        await prepareAirbnbHotel(sharedSetupClient, propertyId, commandId, signal);
        setPreparing(false);
        result = await start();
      }
      signal.throwIfAborted();
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
      if (signal.aborted) return;
      setPreparing(false);
      const status =
        typeof cause === "object" && cause !== null && "status" in cause ? cause.status : undefined;
      setError(
        cause instanceof AirbnbPreparationError
          ? cause.message
          : status === 409
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
        We’ll prepare your hotel’s connection first if needed. Then sign in to Airbnb and approve
        access. You’ll return here to choose listings, review their details, and fill in anything
        missing before saving rooms.
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
        {preparing ? "Preparing your hotel…" : connecting ? "Connecting…" : "Continue to Airbnb"}
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
