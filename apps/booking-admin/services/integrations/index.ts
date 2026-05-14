import { apiClient } from '../api/client'

/**
 * Per-hotel Lodgify connection status returned by the backend.
 *
 * The encrypted API key is intentionally never sent to the client —
 * once a property is connected the UI only shows the Lodgify property
 * name, the last-validated timestamp, and a Disconnect button.
 */
export interface LodgifyConnectionStatus {
  connected: boolean
  status: 'active' | 'disconnected' | 'error'
  lodgify_property_id: string | null
  lodgify_property_name: string | null
  last_validated_at: string | null
  last_error: string | null
}

export interface LodgifyConnectRequest {
  api_key: string
  lodgify_property_id: string
}

export const integrationsService = {
  getLodgifyStatus: () =>
    apiClient.get<LodgifyConnectionStatus>('/admin/integrations/lodgify/status'),

  connectLodgify: (data: LodgifyConnectRequest) =>
    apiClient.post<LodgifyConnectionStatus>('/admin/integrations/lodgify/connect', data),

  disconnectLodgify: () =>
    apiClient.delete<void>('/admin/integrations/lodgify/disconnect'),
}
