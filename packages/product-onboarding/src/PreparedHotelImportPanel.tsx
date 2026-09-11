"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  IMPORT_PROPERTY_FIELDS,
  type ImportPropertyField,
  type ImportItemResult,
  type PreparedHotelImport,
  type PropertyProfileResponse,
} from "@vayada/domain-hotels";
import { PreparedRoomEditor, importFieldLabels } from "./PreparedHotelEditor";

export type PreparedImportClient = {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
};
export type PreparedImportResponse = {
  import: null | {
    sourceId: string;
    data: PreparedHotelImport;
    propertyId: string | null;
    results: Record<string, ImportItemResult>;
  };
  profile?: PropertyProfileResponse;
  canImportRooms?: boolean;
  canImportProperty?: boolean;
  existingRooms?: { id: string; name: string }[];
};

export function PreparedHotelImportPanel({
  client,
  propertyId,
  importEndpoint,
  emptyMessage,
  roomsOnly = false,
  onSaved,
}: {
  client: PreparedImportClient;
  propertyId: string;
  importEndpoint?: string;
  emptyMessage?: string;
  roomsOnly?: boolean;
  onSaved?: () => void;
}) {
  const [state, setState] = useState<PreparedImportResponse | null>(null);
  const [draft, setDraft] = useState<PreparedHotelImport | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<ImportItemResult[]>([]);
  const endpoint =
    importEndpoint ?? `/api/hotel-setup/properties/${encodeURIComponent(propertyId)}/import`;
  const generation = useRef(0);
  const load = useCallback(
    async (preserveSourceId?: string) => {
      const currentGeneration = generation.current;
      const next = await client.get<PreparedImportResponse>(endpoint);
      if (generation.current !== currentGeneration) return false;
      setState(next);
      if (preserveSourceId && next.import?.sourceId === preserveSourceId) {
        setSelected((current) =>
          current.filter((item) => next.import?.results[item]?.status !== "applied"),
        );
      } else {
        setDraft(next.import?.data ?? null);
        setSelected([]);
      }
      return true;
    },
    [client, endpoint],
  );
  useEffect(() => {
    let active = true;
    generation.current += 1;
    setBusy(false);
    setState(null);
    setDraft(null);
    setSelected([]);
    setResults([]);
    setOpen(false);
    setError("");
    client
      .get<PreparedImportResponse>(endpoint)
      .then((next) => {
        if (active) {
          setState(next);
          setDraft(next.import?.data ?? null);
        }
      })
      .catch(() => {
        // A failed optional import lookup must not block ordinary hotel editing.
        if (active) setError("Prepared hotel data could not be loaded.");
      });
    return () => {
      active = false;
      generation.current += 1;
    };
  }, [client, endpoint]);
  if (!state?.import || !draft || !state.profile) {
    return error ? (
      <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm">
        <p>{error}</p>
        <button
          type="button"
          onClick={() =>
            void load()
              .then((loaded) => {
                if (loaded) setError("");
              })
              .catch(() => setError("Prepared hotel data could not be loaded."))
          }
        >
          Retry prepared data
        </button>
      </div>
    ) : null;
  }
  const source = state.import;
  const profile = state.profile;
  const applied = (item: string) => source.results[item]?.status === "applied";
  const toggle = (item: string) =>
    setSelected((current) =>
      current.includes(item) ? current.filter((key) => key !== item) : [...current, item],
    );
  const currentField = (field: ImportPropertyField) =>
    field === "displayName" || field === "propertyType"
      ? profile.profile[field]
      : profile.profile.location[field];
  const available =
    (!roomsOnly && Object.keys(draft.property).some((field) => !applied(`property:${field}`))) ||
    draft.rooms.some((room) => !applied(`room:${room.id}`));
  if (!available && !results.length)
    return emptyMessage ? (
      <p role="status" className="my-4 text-sm text-gray-600">
        {emptyMessage}
      </p>
    ) : null;

  async function save() {
    if (!draft || !state?.import || !state.profile) return;
    const currentGeneration = generation.current;
    setBusy(true);
    setError("");
    try {
      const property = Object.fromEntries(
        IMPORT_PROPERTY_FIELDS.filter((field) => selected.includes(`property:${field}`)).map(
          (field) => [field, draft.property[field] ?? ""],
        ),
      );
      const response = await client.post<{ items: ImportItemResult[] }>(endpoint, {
        sourceId: state.import.sourceId,
        expectedProfileRevision: state.profile.profileRevision,
        data: {
          ...draft,
          property,
          rooms: draft.rooms.filter((room) => selected.includes(`room:${room.id}`)),
        },
      });
      if (generation.current !== currentGeneration) return;
      setResults(response.items);
      if (response.items.some((item) => item.status === "failed"))
        setError("Some items could not be saved. Review the results below before retrying.");
      await load(state.import.sourceId);
      if (generation.current === currentGeneration) onSaved?.();
    } catch (error) {
      if (generation.current !== currentGeneration) return;
      const code = (error as { data?: { code?: string } })?.data?.code;
      setError(
        code === "incomplete_room_facts"
          ? "Complete each selected room’s guest limits, bed type, number of beds, and bathroom details before saving."
          : code === "import_property_conflict"
            ? "This invitation’s data is already assigned to another hotel. Open that hotel to continue."
            : "Import could not finish. Refresh the prepared data and review it before retrying.",
      );
    } finally {
      if (generation.current === currentGeneration) setBusy(false);
    }
  }
  return (
    <section
      className="my-4 rounded-xl border border-gray-200 bg-white p-5"
      aria-label="Prepared hotel data"
    >
      <button
        type="button"
        className="font-semibold text-gray-900"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Review prepared {roomsOnly ? "room" : "hotel"} data
      </button>
      {open && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-gray-600">
            Saving applies only your selected items to{" "}
            <strong>{profile.profile.displayName}</strong>. Room types are created without stock,
            rates, or publication. Existing rooms are preserved.
          </p>
          <fieldset disabled={busy} className="space-y-4">
            {!roomsOnly &&
              IMPORT_PROPERTY_FIELDS.filter(
                (field) => draft.property[field] !== undefined && !applied(`property:${field}`),
              ).map((field) => (
                <div key={field} className="rounded-lg border border-gray-200 p-3">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      disabled={!state.canImportProperty}
                      checked={selected.includes(`property:${field}`)}
                      onChange={() => toggle(`property:${field}`)}
                    />
                    {importFieldLabels[field]}
                  </label>
                  <p className="mt-1 text-xs text-gray-500">
                    Current: {currentField(field) || "Not provided"}
                  </p>
                  <input
                    aria-label={`Prepared ${importFieldLabels[field]}`}
                    className="mt-2 w-full rounded border border-gray-300 p-2 text-sm"
                    maxLength={300}
                    value={draft.property[field] ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        property: { ...draft.property, [field]: e.target.value },
                      })
                    }
                  />
                </div>
              ))}
            {draft.rooms.map((room) => {
              const key = `room:${room.id}`;
              const duplicate = state.existingRooms?.some(
                (existing) => existing.name.trim().toLowerCase() === room.name.trim().toLowerCase(),
              );
              const disabled = applied(key) || duplicate || !state.canImportRooms;
              return (
                <div key={key} className="rounded-lg border border-gray-200 p-3">
                  <label className="mb-3 flex items-center gap-2 text-sm font-semibold">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={!disabled && selected.includes(key)}
                      onChange={() => toggle(key)}
                    />
                    {room.name}
                  </label>
                  {applied(key) ? (
                    <p className="text-sm text-green-700">
                      Already imported. Your saved edits are preserved.
                    </p>
                  ) : duplicate ? (
                    <p className="text-sm text-amber-800">
                      A room with this name already exists. Keep it, or change this prepared room’s
                      name before importing it as a separate room type.
                    </p>
                  ) : !state.canImportRooms ? (
                    <p className="text-sm text-gray-600">
                      Hotel Operations room-management access is required.
                    </p>
                  ) : null}
                  {!applied(key) && (
                    <PreparedRoomEditor
                      room={room}
                      disabled={!state.canImportRooms}
                      onChange={(updated) => {
                        setSelected((items) => items.filter((item) => item !== key));
                        setDraft({
                          ...draft,
                          rooms: draft.rooms.map((candidate) =>
                            candidate.id === room.id ? updated : candidate,
                          ),
                        });
                      }}
                    />
                  )}
                </div>
              );
            })}
            <div className="flex gap-3">
              <button
                type="button"
                disabled={busy || selected.length === 0}
                className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
                onClick={() => void save()}
              >
                {busy ? "Saving…" : "Save selected items"}
              </button>
              <button type="button" onClick={() => setOpen(false)} className="px-3 text-sm">
                Keep current data
              </button>
              <button
                type="button"
                onClick={() =>
                  void load()
                    .then((loaded) => {
                      if (loaded) {
                        setError("");
                        onSaved?.();
                      }
                    })
                    .catch(() => setError("Prepared data could not be refreshed."))
                }
                className="px-3 text-sm"
              >
                Refresh
              </button>
            </div>
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}
          {results.length > 0 && (
            <ul aria-live="polite" className="space-y-1 text-sm">
              {results.map((item) => (
                <li key={item.itemId}>
                  {item.itemId.startsWith("property:")
                    ? importFieldLabels[item.itemId.slice(9) as ImportPropertyField]
                    : (source.data.rooms.find((room) => `room:${room.id}` === item.itemId)?.name ??
                      "Room")}
                  : {item.status === "applied" ? "Saved" : importErrorMessage(item.error)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
function importErrorMessage(code?: string) {
  if (code === "room_type_name_conflict")
    return "A room with this name already exists. Review its name.";
  if (code === "profile_revision_conflict")
    return "The hotel changed in another session. Refresh and review again.";
  if (code === "incomplete_property_details")
    return "Complete the required hotel details in setup first.";
  if (code === "unsupported_room_fact_keys") return "Choose a supported bed type.";
  return "Not saved. Check the details and try again.";
}
