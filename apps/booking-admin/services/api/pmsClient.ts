/**
 * PMS API client — same pattern as the main apiClient but points to the PMS service.
 */
import { ApiClient } from "./client";

const PMS_BASE_URL = process.env.NEXT_PUBLIC_PMS_URL || "https://api.pms.localhost";

export const pmsClient = new ApiClient(PMS_BASE_URL, { preferLegacyCompatibilityToken: true });
