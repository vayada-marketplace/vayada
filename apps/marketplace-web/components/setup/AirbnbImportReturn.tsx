"use client";

import { useEffect, useRef, useState } from "react";
import { sharedSetupClient } from "@/services/api/sharedHotelSetupClient";

type Result = "ready" | "cancelled" | "unavailable";
const messages = {
  checking: "Checking your Airbnb connection…",
  ready: "Your listing details are saved for review. No rooms have been created.",
  cancelled: "The connection was cancelled. You can continue setting up your hotel manually.",
  unavailable:
    "We could not confirm this connection. Return to hotel setup to try again or continue manually.",
};

export function AirbnbImportReturn({
  propertyId,
  sourceId,
}: {
  propertyId: string;
  sourceId: string;
}) {
  const [result, setResult] = useState<Result | "checking">("checking");
  // Retain one operation across React Strict Mode's effect replay.
  const operation = useRef<Promise<Result> | null>(null);
  useEffect(() => {
    let active = true;
    if (!operation.current) {
      const query = new URLSearchParams(window.location.search);
      // Scrub before API requests, session recovery or continuation navigation.
      window.history.replaceState(window.history.state, "", window.location.pathname);
      operation.current = finish(query, propertyId, sourceId);
    }
    void operation.current.then((value) => {
      if (active) setResult(value);
    });
    return () => {
      active = false;
    };
  }, [propertyId, sourceId]);
  return (
    <main className="mx-auto max-w-xl px-6 py-20">
      <h1 className="mb-4 text-2xl font-semibold">Airbnb connection</h1>
      <p role="status" aria-live="polite" className="mb-6 text-gray-600">
        {messages[result]}
      </p>
      {result !== "checking" && (
        <a
          className="font-medium text-blue-700 underline"
          href={`/setup?propertyId=${encodeURIComponent(propertyId)}`}
        >
          Return to hotel setup
        </a>
      )}
    </main>
  );
}

async function finish(
  query: URLSearchParams,
  propertyId: string,
  sourceId: string,
): Promise<Result> {
  const path = `/api/hotel-setup/properties/${propertyId}/airbnb-import`;
  const keys = ["success", "token", "channel_id"];
  if (keys.some((key) => query.getAll(key).length > 1)) return "unavailable";
  if (query.get("success") === "false") return "cancelled";
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (query.has("success") || query.has("token") || query.has("channel_id")) {
    const state = query.get("token") ?? "";
    const channelId = query.get("channel_id") ?? "";
    if (
      query.get("success") !== "true" ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      !uuid.test(channelId)
    )
      return "unavailable";
    try {
      const completed = await sharedSetupClient.post<{ sourceId: string }>(
        `${path}/complete`,
        { state, channelId },
        { signal: AbortSignal.timeout(15_000), referrerPolicy: "no-referrer" },
      );
      if (completed?.sourceId !== sourceId) return "unavailable";
    } catch {
      // Completion may have committed before the response was lost. Recover by scope.
    }
  }
  try {
    const saved = await sharedSetupClient.get<{ sourceId: string }>(`${path}/sources/${sourceId}`, {
      signal: AbortSignal.timeout(15_000),
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
    return saved?.sourceId === sourceId ? "ready" : "unavailable";
  } catch {
    return "unavailable";
  }
}
