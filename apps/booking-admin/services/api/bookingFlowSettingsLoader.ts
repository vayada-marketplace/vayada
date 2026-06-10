import type { BookingBenefitsSettings } from "./bookingBenefitsSettingsClient";
import type { BookingRoomFilterSettings } from "./bookingRoomFilterSettingsClient";

export type BookingFlowSettingsProperty = {
  id?: string | null;
};

export interface LoadBookingFlowSettingInput<TSettings> {
  selectedHotelId: string | null;
  propertyPromise: Promise<BookingFlowSettingsProperty | null>;
  read: (hotelId: string) => Promise<TSettings>;
  defaultValue: TSettings;
}

export async function loadBookingFlowSetting<TSettings>({
  selectedHotelId,
  propertyPromise,
  read,
  defaultValue,
}: LoadBookingFlowSettingInput<TSettings>): Promise<TSettings> {
  const hotelId = selectedHotelId || (await resolvePropertyHotelId(propertyPromise));
  if (!hotelId) return defaultValue;

  try {
    return await read(hotelId);
  } catch {
    return defaultValue;
  }
}

async function resolvePropertyHotelId(
  propertyPromise: Promise<BookingFlowSettingsProperty | null>,
): Promise<string | null> {
  try {
    const property = await propertyPromise;
    return property?.id || null;
  } catch {
    return null;
  }
}

export function normalizeBookingBenefitsSettings(
  settings: unknown,
  defaultValue: BookingBenefitsSettings,
): BookingBenefitsSettings {
  if (!isRecord(settings) || !Array.isArray(settings.benefits)) {
    return defaultValue;
  }

  return {
    benefits: settings.benefits.filter((benefit): benefit is string => typeof benefit === "string"),
  };
}

export function normalizeBookingRoomFilterSettings(
  settings: unknown,
  defaultValue: BookingRoomFilterSettings,
): BookingRoomFilterSettings {
  if (!isRecord(settings)) return defaultValue;

  return {
    bookingFilters: Array.isArray(settings.bookingFilters)
      ? settings.bookingFilters.filter((key): key is string => typeof key === "string")
      : [],
    customFilters: toStringRecord(settings.customFilters),
    filterRooms: toStringArrayRecord(settings.filterRooms),
  };
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function toStringArrayRecord(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
      .map(([key, roomIds]) => [
        key,
        roomIds.filter((roomId): roomId is string => typeof roomId === "string"),
      ]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
