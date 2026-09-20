"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ApiErrorResponse } from "@/services/api/client";
import { createReplacementPricingClient } from "@/services/api/replacementPricingClient";
import { pmsOperationsRoomsReadService } from "@/services/rooms";
import {
  readOfferPreview,
  requestOfferProvisioning,
  type OfferPreviewResult,
} from "@/services/channex/offerPreview";
import { channelManagerButtonClass } from "./ChannelManagerUi";

type Publication = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createReplacementPricingClient>["read"]>>
>;
const inputClass =
  "mt-1 w-full rounded-lg border border-gray-300 bg-white p-2 text-sm disabled:bg-gray-50";
export function OfferPreview({ propertyId }: { propertyId: string }) {
  return <PropertyPreview key={propertyId} propertyId={propertyId} />;
}
function PropertyPreview({ propertyId }: { propertyId: string }) {
  const [publication, setPublication] = useState<Publication | null>(null),
    [names, setNames] = useState<Record<string, string>>({});
  const [refresh, setRefresh] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setPublication(null);
    setError("");
    void Promise.all([
      createReplacementPricingClient(propertyId).read(),
      pmsOperationsRoomsReadService.listRoomTypes(propertyId),
    ])
      .then(([pricing, rooms]) => {
        if (!active) return;
        if (rooms.propertyId !== propertyId) throw new Error("Room scope changed");
        if (pricing?.stale) {
          setError(
            "Published pricing is out of date. Update and publish pricing before previewing.",
          );
          return;
        }
        setNames(Object.fromEntries(rooms.items.map((room) => [room.roomTypeId, room.name])));
        setPublication(pricing);
      })
      .catch((failure: unknown) => {
        if (!active) return;
        if (failure instanceof ApiErrorResponse && failure.status === 403) setDenied(true);
        else setError("Published pricing could not be loaded. Try again.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [propertyId, refresh]);
  if (denied) return null;
  return (
    <section
      className="rounded-xl border border-gray-200 bg-white p-5 md:p-6"
      aria-label="Channel configuration preview"
    >
      <h2 className="font-semibold text-gray-950">Channel configuration preview</h2>
      <p className="mt-1 text-sm text-gray-600">
        Preview only — nothing has been sent to channels.
      </p>
      {loading ? (
        <p role="status" className="mt-4 text-sm">
          Loading published pricing…
        </p>
      ) : error ? (
        <div role="alert" className="mt-4 text-sm text-red-700">
          {error}{" "}
          <Link href="/pricing" className="underline">
            Open pricing
          </Link>
        </div>
      ) : !publication ? (
        <p className="mt-4 text-sm">
          Publish pricing first.{" "}
          <Link href="/pricing" className="underline">
            Open pricing
          </Link>
        </p>
      ) : (
        <PreviewSelection
          key={publication.revision}
          propertyId={propertyId}
          publication={publication}
          names={names}
          onDenied={() => setDenied(true)}
          onRefresh={() => setRefresh((value) => value + 1)}
        />
      )}
      {!loading && (
        <button
          type="button"
          className={`${channelManagerButtonClass} mt-4 border border-gray-300`}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh published pricing
        </button>
      )}
    </section>
  );
}
function PreviewSelection({
  propertyId,
  publication,
  names,
  onRefresh,
  onDenied,
}: {
  propertyId: string;
  publication: Publication;
  names: Record<string, string>;
  onRefresh(): void;
  onDenied(): void;
}) {
  const [roomId, setRoomId] = useState(""),
    [offerId, setOfferId] = useState(""),
    [primary, setPrimary] = useState("");
  const [result, setResult] = useState<OfferPreviewResult | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [provisioned, setProvisioned] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const room = publication.rooms.find((room) => room.roomTypeId === roomId);
  const clear = () => {
    sequence.current++;
    setResult(null);
    setLoading(false);
    setError("");
    setProvisioned(false);
  };
  async function preview() {
    if (!room || !offerId || !primary) return;
    const current = ++sequence.current;
    setLoading(true);
    setResult(null);
    setError("");
    try {
      const next = await readOfferPreview(propertyId, room, offerId, Number(primary));
      if (current === sequence.current) setResult(next);
    } catch (failure) {
      if (current !== sequence.current) return;
      if (failure instanceof ApiErrorResponse && failure.status === 403) {
        onDenied();
        return;
      }
      if (failure instanceof ApiErrorResponse && failure.status === 409) {
        clear();
        setRefreshRequired(true);
        setRoomId("");
        setOfferId("");
        setPrimary("");
        setError("Pricing changed. Refresh published pricing and choose again.");
      } else setError("The preview could not be loaded. Try again or refresh published pricing.");
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }
  async function provision() {
    if (!room || !offerId || !primary || result?.kind !== "preview") return;
    const current = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      await requestOfferProvisioning(propertyId, room, offerId, Number(primary));
      if (current === sequence.current) setProvisioned(true);
    } catch (failure) {
      if (current !== sequence.current) return;
      if (failure instanceof ApiErrorResponse && failure.status === 403) {
        onDenied();
        return;
      }
      if (failure instanceof ApiErrorResponse && failure.status === 409) {
        setError("Channex setup is not enabled for this property.");
      } else setError("The Channex setup request could not be saved. Try again.");
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }
  return (
    <div className="mt-5 space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium">
          Room type
          <select
            aria-label="Preview room type"
            className={inputClass}
            value={roomId}
            disabled={refreshRequired}
            onChange={(e) => {
              clear();
              setRoomId(e.target.value);
              setOfferId("");
              setPrimary("");
            }}
          >
            <option value="">Choose a room</option>
            {publication.rooms.map((room) => (
              <option key={room.roomTypeId} value={room.roomTypeId}>
                {names[room.roomTypeId] ?? "Unnamed room"}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium">
          Published offer
          <select
            aria-label="Published offer"
            className={inputClass}
            value={offerId}
            disabled={!room || refreshRequired}
            onChange={(e) => {
              clear();
              setOfferId(e.target.value);
              setPrimary("");
            }}
          >
            <option value="">Choose an offer</option>
            {room?.offers.map((offer, index) => (
              <option key={offer.id} value={offer.id}>
                Offer {index + 1} — {offer.meal.kind.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-sm font-medium">
        Primary guest count
        <select
          aria-label="Primary guest count"
          aria-describedby="primary-guest-help"
          className={inputClass}
          value={primary}
          disabled={!offerId || refreshRequired}
          onChange={(e) => {
            clear();
            setPrimary(e.target.value);
          }}
        >
          <option value="">Choose a guest count</option>
          {Array.from({ length: Math.min(room?.capacity.adults ?? 0, 100) }, (_, i) => (
            <option key={i + 1} value={i + 1}>
              {i + 1}
            </option>
          ))}
        </select>
      </label>
      <p id="primary-guest-help" className="text-sm text-gray-500">
        The default occupancy option for the channel rate. This does not multiply the price. This
        choice is saved only when you request Channex setup.
      </p>
      <button
        type="button"
        onClick={() => void preview()}
        disabled={!room || !offerId || !primary || loading || refreshRequired}
        className={`${channelManagerButtonClass} bg-gray-950 text-white`}
      >
        Preview configuration
      </button>
      {loading && (
        <p role="status" className="text-sm">
          Loading configuration…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {refreshRequired && (
        <button type="button" onClick={onRefresh} className="text-sm underline">
          Refresh and choose again
        </button>
      )}
      {result?.kind === "unsupported" && (
        <p role="status" className="text-sm text-amber-800">
          {result.reason === "child_representation_unavailable"
            ? "Rooms with child pricing are not supported by this preview yet."
            : "This room exceeds the preview limit of 100 adult occupancy options."}
        </p>
      )}
      {result?.kind === "preview" && (
        <div role="status" className="rounded-lg bg-gray-50 p-4 text-sm space-y-2">
          <p>Currency: {result.currency}</p>
          <p className="capitalize">Meal: {result.meal}</p>
          <p>Guest counts: {result.occupancies.join(", ")}</p>
          <p>Primary guest count: {result.primary}</p>
          <p className="text-gray-500">
            Live setup still requires channel mapping, supported booking rules, and verified price
            and restriction delivery.
          </p>
          <button
            type="button"
            onClick={() => void provision()}
            disabled={loading || provisioned}
            className={`${channelManagerButtonClass} bg-gray-950 text-white`}
          >
            {provisioned ? "Channex setup requested" : "Request Channex setup"}
          </button>
        </div>
      )}
    </div>
  );
}
