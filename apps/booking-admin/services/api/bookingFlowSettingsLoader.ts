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
