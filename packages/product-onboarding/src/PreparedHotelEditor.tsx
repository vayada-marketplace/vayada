"use client";
import {
  IMPORT_PROPERTY_FIELDS,
  PREPARED_HOTEL_IMPORT_VERSION,
  type PreparedHotelImport,
  type PreparedRoom,
} from "@vayada/domain-hotels";

export const importFieldLabels = {
  displayName: "Hotel name",
  propertyType: "Property type",
  streetAddress: "Street address",
  postalCode: "Postal code",
  city: "City",
  countryCode: "Country code",
  timezone: "Time zone",
};
const inputClass =
  "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900";
export function emptyPreparedData(): PreparedHotelImport {
  return { contractVersion: PREPARED_HOTEL_IMPORT_VERSION, property: {}, rooms: [] };
}
export function PreparedHotelEditor({
  value,
  onChange,
  allowRooms = true,
}: {
  value: PreparedHotelImport;
  onChange: (value: PreparedHotelImport) => void;
  allowRooms?: boolean;
}) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-600">
        Prepare the details you know. The owner reviews them before saving. Leave unknown details
        blank.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {IMPORT_PROPERTY_FIELDS.map((field) => (
          <label key={field} className="text-sm text-gray-700">
            {importFieldLabels[field]}
            <input
              className={inputClass}
              maxLength={300}
              value={value.property[field] ?? ""}
              placeholder={
                field === "timezone"
                  ? "Europe/Berlin"
                  : field === "propertyType"
                    ? "hotel"
                    : field === "countryCode"
                      ? "DE"
                      : undefined
              }
              onChange={(event) => {
                const property = { ...value.property };
                if (event.target.value) property[field] = event.target.value;
                else delete property[field];
                onChange({ ...value, property });
              }}
            />
          </label>
        ))}
      </div>
      {value.rooms.map((room) => (
        <fieldset key={room.id} className="rounded-xl border border-gray-200 p-4">
          <legend className="px-2 text-sm font-semibold">{room.name || "New room type"}</legend>
          <PreparedRoomEditor
            room={room}
            onChange={(updated) =>
              onChange({
                ...value,
                rooms: value.rooms.map((item) => (item.id === room.id ? updated : item)),
              })
            }
          />
          <button
            type="button"
            className="mt-3 text-sm text-red-700"
            onClick={() =>
              onChange({ ...value, rooms: value.rooms.filter((item) => item.id !== room.id) })
            }
          >
            Remove prepared room
          </button>
        </fieldset>
      ))}
      {allowRooms && (
        <button
          type="button"
          disabled={value.rooms.length >= 50}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium disabled:opacity-50"
          onClick={() =>
            onChange({
              ...value,
              rooms: [
                ...value.rooms,
                {
                  id: crypto.randomUUID(),
                  name: "",
                  description: "",
                  maxGuests: null,
                  maxAdults: null,
                  maxChildren: null,
                  bedType: "",
                  bedQuantity: null,
                  bathroomType: "",
                  sizeSquareMetres: null,
                },
              ],
            })
          }
        >
          Add prepared room type
        </button>
      )}
      {!allowRooms && value.rooms.length > 0 && (
        <p role="alert" className="text-sm text-red-700">
          Choose Hotel Operations or remove the prepared rooms.
        </p>
      )}
    </div>
  );
}

export function PreparedRoomEditor({
  room,
  onChange,
  disabled = false,
}: {
  room: PreparedRoom;
  onChange: (room: PreparedRoom) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2 disabled:opacity-60">
      <label className="text-sm text-gray-700">
        Room name
        <input
          className={inputClass}
          required
          maxLength={200}
          value={room.name}
          onChange={(e) => onChange({ ...room, name: e.target.value })}
        />
      </label>
      <label className="text-sm text-gray-700">
        Description
        <textarea
          className={inputClass}
          maxLength={5000}
          value={room.description}
          onChange={(e) => onChange({ ...room, description: e.target.value })}
        />
      </label>
      {(
        [
          ["maxGuests", "Maximum guests"],
          ["maxAdults", "Maximum adults"],
          ["maxChildren", "Maximum children"],
          ["bedQuantity", "Number of beds"],
          ["sizeSquareMetres", "Size (m²)"],
        ] as const
      ).map(([key, label]) => (
        <label key={key} className="text-sm text-gray-700">
          {label}
          <input
            className={inputClass}
            type="number"
            min={key === "sizeSquareMetres" ? 0.01 : 0}
            max={key === "sizeSquareMetres" ? 10000 : 100}
            step={key === "sizeSquareMetres" ? "any" : 1}
            value={room[key] ?? ""}
            onChange={(e) =>
              onChange({ ...room, [key]: e.target.value === "" ? null : Number(e.target.value) })
            }
          />
        </label>
      ))}
      <label className="text-sm text-gray-700">
        Bed type
        <select
          className={inputClass}
          value={room.bedType}
          onChange={(e) => onChange({ ...room, bedType: e.target.value })}
        >
          <option value="">Not provided</option>
          {[
            ["king", "King"],
            ["queen", "Queen"],
            ["double", "Double"],
            ["twin", "Twin"],
            ["single", "Single"],
            ["bunk_bed", "Bunk bed"],
            ["sofa_bed", "Sofa bed"],
          ].map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm text-gray-700">
        Bathroom
        <select
          className={inputClass}
          value={room.bathroomType}
          onChange={(e) =>
            onChange({ ...room, bathroomType: e.target.value as PreparedRoom["bathroomType"] })
          }
        >
          <option value="">Not provided</option>
          <option value="private">Private</option>
          <option value="shared">Shared</option>
        </select>
      </label>
    </fieldset>
  );
}
