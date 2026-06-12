import { ApiClient } from "./client";

const PMS_OPERATIONS_API_URL =
  process.env.NEXT_PUBLIC_PMS_OPERATIONS_API_URL ||
  process.env.NEXT_PUBLIC_VAYADA_API_URL ||
  "https://api.localhost";

export const pmsOperationsClient = new ApiClient(PMS_OPERATIONS_API_URL);
