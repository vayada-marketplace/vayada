import { settingsService, type SetupStatusResponse } from '@/services/settings'

export async function checkSetupStatus(): Promise<SetupStatusResponse | null> {
  try {
    return await settingsService.getSetupStatus()
  } catch {
    return null
  }
}

// "Setup complete" for routing purposes means "the user has at least one
// hotel". We intentionally don't check whether every booking_hotels
// metadata field is filled in — blocking users out of the dashboard
// because contact_phone is empty is user-hostile, and those fields are
// editable from the normal settings page anyway. The fine-grained
// missing-fields info is still available via checkSetupStatus() for the
// setup wizard's prefill logic.
export async function isSetupComplete(): Promise<boolean> {
  try {
    const hotels = await settingsService.listHotels()
    return hotels.length > 0
  } catch {
    return false
  }
}
