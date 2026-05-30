import { ApiClient } from "./client";

const PMS_API_URL = process.env.NEXT_PUBLIC_PMS_API_URL || "https://pms-api.vayada.com";

export const pmsApiClient = new ApiClient(PMS_API_URL);
