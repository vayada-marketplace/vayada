import { pmsClient } from '../api/pmsClient'

export interface PmsSetupStatus {
  registered: boolean
  setupComplete: boolean
  roomCount: number
}

export const pmsSettingsService = {
  getSetupStatus: () =>
    pmsClient.get<PmsSetupStatus>('/admin/setup-status'),
}
