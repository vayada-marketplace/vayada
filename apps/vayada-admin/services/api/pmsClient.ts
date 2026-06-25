import { ApiClient, API_BASE_URL } from "./client";

const PMS_API_URL = process.env.NEXT_PUBLIC_PMS_API_URL || API_BASE_URL;

export const pmsApiClient = new ApiClient(PMS_API_URL);
