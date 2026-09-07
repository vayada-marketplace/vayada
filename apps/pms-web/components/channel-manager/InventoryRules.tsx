"use client";

import { useRef, useState } from "react";
import { INVENTORY_RULE_DAYS, type ChannexInventoryRule } from "@vayada/domain-pms-channex";
import { channexService, type ChannexSnapshot } from "@/services/channex";
import { channelManagerButtonClass as buttonClass, OperationBanner } from "./ChannelManagerUi";

const labels = {
  availability_offset: "Availability offset",
  max_availability: "Maximum availability",
  close_out: "Channel close-out",
};
const inputClass = "mt-1 block w-full rounded-lg border border-gray-300 p-2 text-sm";

export function InventoryRules({
  snapshot,
  disabled,
  refresh,
}: {
  snapshot: ChannexSnapshot;
  disabled: boolean;
  refresh: () => Promise<void>;
}) {
  const rules = snapshot.inventoryRules?.rules ?? [];
  const operation = snapshot.inventoryRules?.operation ?? null;
  const [draft, setDraft] = useState<ChannexInventoryRule | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submission = useRef<{ payload: string; id: string } | null>(null);
  const busy = disabled || saving;
  const channels = snapshot.channels.filter(
    (channel) => channel.isActive && channel.externalChannelId,
  );
  const rooms = snapshot.mappings.roomTypes.filter((room) => room.status === "active");
  const channelName = (id: string) =>
    snapshot.channels.find((channel) => channel.externalChannelId === id)?.title ||
    snapshot.channels.find((channel) => channel.externalChannelId === id)?.application ||
    id;
  const roomName = (id: string) =>
    snapshot.mappings.roomTypes.find((room) => room.roomTypeId === id)?.roomTypeName || id;
  const exclusions = (rule: ChannexInventoryRule) =>
    snapshot.channels.filter(
      (channel) =>
        channel.isActive &&
        (!channel.externalChannelId || !rule.channelIds.includes(channel.externalChannelId)),
    );

  async function save(next: ChannexInventoryRule[]) {
    if (saving) return;
    setSaving(true);
    setError("");
    const expectedOperationId = operation?.operationId ?? null;
    const payload = JSON.stringify({ rules: next, expectedOperationId });
    if (submission.current?.payload !== payload)
      submission.current = { payload, id: crypto.randomUUID() };
    try {
      await channexService.updateInventoryRules(next, expectedOperationId, submission.current.id);
      setDraft(null);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The rule update could not be confirmed. Refresh or retry.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5 md:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-gray-950">Channel inventory rules</h2>
        <button
          type="button"
          className={`${buttonClass} bg-gray-950 text-white`}
          disabled={busy || !channels.length || !rooms.length}
          onClick={() => {
            setError("");
            setDraft({
              id: crypto.randomUUID(),
              type: "availability_offset",
              value: 1,
              channelIds: channels.map((channel) => channel.externalChannelId!),
              roomTypeIds: [],
              startDate: "",
              endDate: "",
              days: [...INVENTORY_RULE_DAYS],
            });
          }}
        >
          Add rule
        </button>
      </div>
      <p className="mt-2 text-sm text-gray-600">
        Control the rooms offered to selected OTAs. Direct availability and existing reservations
        stay unchanged. Rules cannot overlap for the same channel, room type and date.
      </p>
      {(!channels.length || !rooms.length) && (
        <p className="mt-3 text-sm text-amber-800">
          Connect OTA channels and provision room mappings before adding rules. Refresh mappings if
          channel choices are missing.
        </p>
      )}
      {operation && <OperationBanner operation={operation} />}
      {operation && operation.status !== "succeeded" && (
        <p className="mt-2 text-sm text-amber-800">
          These are requested rules. Changes may be partially applied and are not confirmed until
          synchronization succeeds.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {rules.length === 0 && (
        <p className="mt-4 text-sm text-gray-500">No requested inventory rules.</p>
      )}
      <ul className="mt-4 divide-y divide-gray-100">
        {rules.map((rule) => (
          <li key={rule.id} className="py-4 text-sm">
            <p className="font-semibold">
              {labels[rule.type]}
              {rule.value !== null ? `: ${rule.value} rooms` : ""}
            </p>
            <p className="mt-1">
              {rule.startDate} – {rule.endDate} · {rule.days.join(", ")}
            </p>
            <p>Channels: {rule.channelIds.map(channelName).join(", ")}</p>
            <p>Room types: {rule.roomTypeIds.map(roomName).join(", ")}</p>
            {rule.type === "availability_offset" && (
              <p className="mt-1 text-gray-600">
                {exclusions(rule).length
                  ? `Excluded connected channels: ${exclusions(rule)
                      .map((channel) => channel.title || channel.application)
                      .join(", ")}. These channels can still sell the last rooms.`
                  : "Applies to all currently connected OTA channels to keep the last rooms for direct bookings. Review this rule when connecting another channel."}
              </p>
            )}
            {rule.type === "max_availability" && (
              <p className="mt-1 text-gray-600">
                Availability ceiling, not a cumulative sales quota. Availability can replenish after
                bookings.
              </p>
            )}
            <div className="mt-2 flex gap-4">
              <button
                type="button"
                disabled={busy}
                className="font-semibold text-primary-700 disabled:opacity-40"
                onClick={() => setDraft(rule)}
              >
                Edit
              </button>
              <button
                type="button"
                disabled={busy}
                className="font-semibold text-red-700 disabled:opacity-40"
                onClick={() => void save(rules.filter((item) => item.id !== rule.id))}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
      {operation && ["failed", "dead_lettered"].includes(operation.status) && (
        <button
          type="button"
          disabled={busy}
          className={`${buttonClass} mt-3 border border-gray-300`}
          onClick={() => void save(rules)}
        >
          Retry synchronization
        </button>
      )}
      {draft && (
        <form
          className="mt-5 space-y-4 border-t border-gray-200 pt-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.channelIds.length || !draft.roomTypeIds.length || !draft.days.length) {
              setError("Select at least one channel, room type and weekday.");
              return;
            }
            void save([...rules.filter((rule) => rule.id !== draft.id), draft]);
          }}
        >
          <fieldset disabled={busy} className="space-y-4">
            <legend className="font-semibold">
              {rules.some((rule) => rule.id === draft.id) ? "Edit rule" : "New rule"}
            </legend>
            <label className="block text-sm">
              Rule type
              <select
                className={inputClass}
                value={draft.type}
                onChange={(event) => {
                  const type = event.target.value as ChannexInventoryRule["type"];
                  setDraft({
                    ...draft,
                    type,
                    value: type === "close_out" ? null : (draft.value ?? 1),
                  });
                }}
              >
                {Object.entries(labels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {draft.type !== "close_out" && (
              <label className="block text-sm">
                Rooms
                <input
                  className={inputClass}
                  type="number"
                  required
                  min={0}
                  max={9999}
                  step={1}
                  value={draft.value ?? ""}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      value: event.target.value === "" ? null : Number(event.target.value),
                    })
                  }
                />
              </label>
            )}
            <p className="text-sm text-gray-600">
              {draft.type === "max_availability"
                ? "This is an availability ceiling, not a cumulative sales quota. Availability can replenish after bookings."
                : draft.type === "availability_offset"
                  ? "Keep N rooms off the selected channels. Select every connected OTA to keep the last rooms for direct bookings."
                  : "Selected channels receive zero availability on these dates. Other channels remain unchanged."}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                From
                <input
                  className={inputClass}
                  type="date"
                  required
                  value={draft.startDate}
                  onChange={(event) => setDraft({ ...draft, startDate: event.target.value })}
                />
              </label>
              <label className="text-sm">
                Through (inclusive)
                <input
                  className={inputClass}
                  type="date"
                  required
                  min={draft.startDate}
                  value={draft.endDate}
                  onChange={(event) => setDraft({ ...draft, endDate: event.target.value })}
                />
              </label>
            </div>
            <fieldset>
              <legend className="text-sm font-medium">Channels</legend>
              {channels.map((channel) => (
                <label
                  key={channel.externalChannelId}
                  className="mt-2 flex items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={draft.channelIds.includes(channel.externalChannelId!)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        channelIds: event.target.checked
                          ? [...draft.channelIds, channel.externalChannelId!]
                          : draft.channelIds.filter((id) => id !== channel.externalChannelId),
                      })
                    }
                  />
                  {channel.title || channel.application}
                </label>
              ))}
            </fieldset>
            {draft.type === "availability_offset" && exclusions(draft).length > 0 && (
              <p className="text-sm text-amber-800">
                Excluded connected channels:{" "}
                {exclusions(draft)
                  .map((channel) => channel.title || channel.application)
                  .join(", ")}
                . They can still sell the last rooms.
              </p>
            )}
            <fieldset>
              <legend className="text-sm font-medium">Room types</legend>
              {rooms.map((room) => (
                <label key={room.roomTypeId} className="mt-2 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.roomTypeIds.includes(room.roomTypeId)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        roomTypeIds: event.target.checked
                          ? [...draft.roomTypeIds, room.roomTypeId]
                          : draft.roomTypeIds.filter((id) => id !== room.roomTypeId),
                      })
                    }
                  />
                  {room.roomTypeName}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend className="text-sm font-medium">Weekdays</legend>
              <div className="mt-2 flex flex-wrap gap-3">
                {INVENTORY_RULE_DAYS.map((day) => (
                  <label key={day} className="flex items-center gap-1 text-sm uppercase">
                    <input
                      type="checkbox"
                      checked={draft.days.includes(day)}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          days: event.target.checked
                            ? [...draft.days, day]
                            : draft.days.filter((value) => value !== day),
                        })
                      }
                    />
                    {day}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex gap-3">
              <button className={`${buttonClass} bg-primary-600 text-white`} type="submit">
                Save and synchronize
              </button>
              <button
                className={`${buttonClass} border border-gray-300`}
                type="button"
                onClick={() => setDraft(null)}
              >
                Cancel
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}
