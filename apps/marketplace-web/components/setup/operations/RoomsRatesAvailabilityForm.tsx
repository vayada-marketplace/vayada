"use client";

import { useContext, useEffect, useState, type FormEvent } from "react";

import {
  hotelOperationsErrorMessage,
  hotelOperationsSetupApi,
  type ExistingRoomSetup,
  type RoomSetupState,
} from "@/services/api/hotelOperationsSetupClient";

import { RoomImportRevisionContext } from "../RoomImportRevisionContext";

import {
  OperationFormLoadError,
  OperationFormLoading,
  OperationFormShell,
} from "./OperationFormShell";

/**
 * Rooms are created in PMS Rooms & Rates, which owns the room-facts commands and each room's
 * Prices tab. This step only reads room readiness and hands the hotel to that page.
 */
export function RoomsRatesAvailabilityForm({
  onBack,
  onCompleted,
  onOpenRoomsAndRates,
  propertyId,
  taskComplete,
}: {
  onBack: (() => void) | null;
  onCompleted: () => void | Promise<void>;
  onOpenRoomsAndRates: () => void | Promise<void>;
  propertyId: string;
  taskComplete: boolean;
}) {
  const [roomState, setRoomState] = useState<RoomSetupState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const importRevision = useContext(RoomImportRevisionContext);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    setError("");
    setRoomState(null);
    void hotelOperationsSetupApi
      .getRoomSetupState(propertyId, controller.signal)
      .then((nextRoomState) => {
        if (!controller.signal.aborted) setRoomState(nextRoomState);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setLoadError(
            hotelOperationsErrorMessage(cause, "Existing room setup could not be loaded."),
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [importRevision, propertyId, reloadToken, taskComplete]);

  // The handoff leaves this page, so the step stays busy instead of allowing a second handoff.
  const openRoomsAndRates = async () => {
    setSubmitting(true);
    setError("");
    await onOpenRoomsAndRates();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (roomState?.status === "empty") {
      await openRoomsAndRates();
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      if (roomState?.status === "complete") {
        await refreshProgress();
        return;
      }
      const refreshed = await hotelOperationsSetupApi.getRoomSetupState(propertyId);
      setRoomState(refreshed);
      if (refreshed.status === "complete") await refreshProgress();
    } catch (cause) {
      setError(hotelOperationsErrorMessage(cause, "Room setup could not be checked."));
    } finally {
      setSubmitting(false);
    }
  };

  const refreshProgress = async () => {
    try {
      await onCompleted();
    } catch {
      setError("Setup progress could not be refreshed. Try again.");
    }
  };

  if (loading) return <OperationFormLoading />;
  if (loadError) {
    return (
      <OperationFormLoadError
        message={loadError}
        onBack={onBack}
        onRetry={() => setReloadToken((current) => current + 1)}
      />
    );
  }

  if (roomState?.status === "complete") {
    return (
      <OperationFormShell
        error={error}
        notice={
          <div className="space-y-1">
            <p className="font-semibold">Rooms and rates are already set up.</p>
            <p>
              This step is read-only to prevent duplicate inventory. You can make later changes in
              Rooms &amp; Rates.
            </p>
          </div>
        }
        onBack={onBack}
        onSubmit={handleSubmit}
        submitLabel="Continue"
        submitting={submitting}
      >
        {roomState.room ? <RoomSetupSummary room={roomState.room} /> : null}
      </OperationFormShell>
    );
  }

  if (roomState?.status === "needs_recovery") {
    return (
      <OperationFormShell
        error={error}
        onBack={onBack}
        onSubmit={handleSubmit}
        secondaryAction={{ label: "Open Rooms & Rates", onClick: () => void openRoomsAndRates() }}
        submitLabel="Check setup again"
        submitting={submitting}
      >
        <div
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:col-span-2"
          role="status"
        >
          <p className="font-semibold">This room setup needs attention.</p>
          <p className="mt-1">
            vayada found existing room setup data, so it will not create another room type. Complete
            the missing items in the PMS, then check this step again.
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5">
            {roomRecoveryMessages(roomState.reasonCodes, roomState.room?.active === true).map(
              (message) => (
                <li key={message}>{message}</li>
              ),
            )}
          </ul>
        </div>
        {roomState.room ? <RoomSetupSummary room={roomState.room} /> : null}
      </OperationFormShell>
    );
  }

  return (
    <OperationFormShell
      error={error}
      onBack={onBack}
      onSubmit={handleSubmit}
      submitLabel="Open Rooms & Rates"
      submitting={submitting}
      submittingLabel="Opening..."
    >
      <div className="space-y-2 text-sm leading-6 text-gray-700 sm:col-span-2">
        <p className="font-semibold text-gray-950">Add your room types in Rooms &amp; Rates.</p>
        <p>
          Create each room type and its rooms in the PMS, then set its prices in the room&apos;s
          Prices tab.
        </p>
      </div>
    </OperationFormShell>
  );
}

function roomRecoveryMessages(reasonCodes: string[], hasActiveRoom: boolean): string[] {
  const messages = reasonCodes.flatMap((reasonCode) => {
    switch (reasonCode) {
      case "missing_non_retired_room":
        return ["Add at least one active physical room."];
      case "missing_active_rate_plan":
        return ["Activate a rate plan for this room type."];
      case "missing_future_inventory":
        return ["Add future availability for this room type."];
      case "missing_active_room_type":
        return hasActiveRoom ? [] : ["Make the existing room type active."];
      default:
        return [];
    }
  });
  return messages.length > 0
    ? messages
    : ["Finish the remaining room, rate, and availability requirements."];
}

function RoomSetupSummary({ room }: { room: ExistingRoomSetup }) {
  return (
    <RoomSummary
      currency={room.currency}
      maxOccupancy={room.maxOccupancy}
      name={room.name}
      nightlyRate={room.nightlyRate}
      totalRooms={room.totalRooms}
    />
  );
}

function RoomSummary({
  currency,
  maxOccupancy,
  name,
  nightlyRate,
  totalRooms,
}: {
  currency: string;
  maxOccupancy: number;
  name: string;
  nightlyRate: string;
  totalRooms: number;
}) {
  const summary = [
    ["Room type", name || "Not entered"],
    ["Number of rooms", Number.isFinite(totalRooms) ? String(totalRooms) : "Not entered"],
    ["Max guests", Number.isFinite(maxOccupancy) ? String(maxOccupancy) : "Not entered"],
    ["Nightly rate", `${currency} ${nightlyRate}`],
  ];

  return (
    <dl className="grid grid-cols-1 gap-4 rounded-xl border border-gray-200 bg-gray-50 p-4 sm:col-span-2 sm:grid-cols-2">
      {summary.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs font-medium text-gray-600">{label}</dt>
          <dd className="mt-1 text-sm font-semibold text-gray-950">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
