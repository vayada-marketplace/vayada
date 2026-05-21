/**
 * PMS API client — points to the PMS backend service.
 */
import { ApiClient } from './client'

const PMS_BASE_URL = process.env.NEXT_PUBLIC_PMS_API_URL || 'http://localhost:8002'

export const pmsClient = new ApiClient(PMS_BASE_URL)
