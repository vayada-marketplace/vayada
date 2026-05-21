import { pmsSettingsService, type PmsSetupStatus } from '@/services/settings'

export async function checkPmsSetupStatus(): Promise<PmsSetupStatus | null> {
  try {
    return await pmsSettingsService.getSetupStatus()
  } catch {
    return null
  }
}

export async function isPmsSetupComplete(): Promise<boolean> {
  const status = await checkPmsSetupStatus()
  return status?.setupComplete ?? false
}

export async function isPmsRegistered(): Promise<boolean> {
  const status = await checkPmsSetupStatus()
  return status?.registered ?? false
}
