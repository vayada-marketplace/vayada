import { settingsService, type SetupStatusResponse } from '@/services/settings'

export async function checkSetupStatus(): Promise<SetupStatusResponse | null> {
  try {
    return await settingsService.getSetupStatus()
  } catch {
    return null
  }
}

export async function isSetupComplete(): Promise<boolean> {
  const status = await checkSetupStatus()
  return status?.setup_complete ?? false
}
